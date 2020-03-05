const polka = require('polka');
const Database = require('sqlite-async');
const cors = require('cors');
const { json } = require('body-parser');
const { join } = require('path');
const moment = require('moment');
const os = require('os');
const ifaces = os.networkInterfaces();
const serveStatic = require('serve-static');
const history = require('connect-history-api-fallback');

const PORT = 3001;
const tableName = "Measurements";


let db = null,
    ret = null;

const app = polka();
const apiUrl = "/api";

const dir = join(__dirname, 'static');
const serve = serveStatic(dir);


const jsonSend = (req, res, next) => {
    res.json = (payload) => {
        res.setHeader('Content-Type', 'application/json');
        const jsonResponse = JSON.stringify(payload);
        res.end(jsonResponse);
    };
    next()
};

const addStatus = (req, res, next) => {
    res.status = (payload) => {
        res.statusCode = payload;
        return res;
    };
    next()
};

const timeMachine = (number, unit) => {
    switch(unit) {
        case "h":
            return moment.utc().subtract(number,'hours');
        case "d":
            return moment.utc().subtract(number, 'days');
        case "w":
            return moment.utc().subtract(number, 'weeks');
        case "m":
            return moment.utc().subtract(number, 'months');
        case "y":
            return moment.utc().subtract(number, 'years');
    }
};

const countSamplesRange = (number, unit) => {
    switch(unit) {
        case "h":
            if (number > 12){
                return 300
            }else{
                return 1
            }
        case "d":
            return 600;
        case "w":
            return 1800;
        case "m":
            return 3600;
        case "y":
            return 43200;
    }
};

const getLocalExternalIp = () => {
    let address;
    Object.keys(ifaces).forEach(dev => {
        ifaces[dev].filter(details => {
            if (details.family === 'IPv4' && details.internal === false) {
                address = details.address;
            }
        });
    });
    return address;
};


const ping = async (req, res) => {
    res.json({response: "Pong"});
};

const addMeasurements = async (req, res) => {
    let data = req.body;
    data.bmp_pressure = Math.round(data.bmp_pressure);
    data.bmp_temp = Math.round(data.bmp_temp * 100);
    data.hdc_temp = Math.round(data.hdc_temp * 100);
    data.hdc_hum = Math.round(data.hdc_hum * 100);
    if(! data.added){
        data.added = new Date();
        data.added = data.added.toISOString();
    }

    let sql = `INSERT INTO Measurements (co2, bmp_pressure, bmp_temp, hdc_temp, hdc_hum, added)
        VALUES (?,?,?,?,?,?)`;
    let params = [data.co2, data.bmp_pressure, data.bmp_temp, data.hdc_temp, data.hdc_hum, data.added];
    try {
        ret = await db.run(sql, params);
    } catch (error) {
        return res.status(500).json({error: error.message})
    }
    res.status(201).json({
        "message": "success",
        "measurement": data,
        "id" : ret.lastID
    });
};

const getMeasurements = async (req, res) => {
    let sql = '';
    if('date' in req.query){
        sql = `SELECT id, bmp_pressure, bmp_temp, hdc_temp, hdc_hum, co2, strftime('%H:%M', added,'localtime') as added FROM Measurements 
                WHERE strftime('%Y-%m-%d', added,'localtime') = '${req.query.date}'
                ORDER BY added ASC`;
    }else{
        sql = 'SELECT * FROM Measurements ORDER BY added DESC';
    }
    try {
        ret = await db.all(sql);
    }catch (error) {
        return res.status(500).json({error: error.message})
    }
    if(ret){
        res.json({
            status: 'success',
            data: ret
        });
    }else {
        res.status(404).json({error: "No data in DB"});
    }
};

const getLastMeasurements = async (req, res) => {
    let sql = `SELECT id, bmp_pressure, bmp_temp, hdc_temp, hdc_hum, co2, strftime('%Y-%m-%d %H:%M', added,'localtime') as added  
                FROM Measurements 
                ORDER BY added DESC 
                LIMIT 1`;
    try {
        ret = await db.get(sql);
    }catch (error) {
        return res.status(500).json({error: error.message})
    }
    if(ret){
        res.json({
            status: 'success',
            data: ret,
            ip: getLocalExternalIp(),
            hostname: os.hostname()
        });
    }else {
        res.status(404).json({error: "No data in DB"});
    }
};

const getValues = async (req, res) => {
    const type = req.params.type;
    const allowedTypes = ["temp", "humidity", "pressure", "co2"];
    let history = false,
        count = 0,
        unit = '';
    if('history' in req.params){
        history = true;
    }
    if( ! allowedTypes.includes(type)){
        res.status(400).json({error: "Bad type of value"});
        return;
    }

    if(history) {
        if (/^[0-9]+[hdwmy]$/.test(req.params.history)) {
            count = req.params.history.match(/^[0-9]+/)[0];
            unit = req.params.history.match(/[hdwmy]$/)[0];
        }else{
            res.status(400).json({error: "Bad interval"});
            return;
        }
    }

    let sqlVar = '';
    switch (type) {
        case "temp":
            sqlVar = ['bmp_temp','hdc_temp'];
            break;
        case "humidity":
            sqlVar = ['hdc_hum'];
            break;
        case "pressure":
            sqlVar = ['bmp_pressure'];
            break;
        case "co2":
            sqlVar = ['co2'];
            break;
        default:
            res.status(400).json({error: "Bad type of value"});
            return;
    }
    let sql = '';
    if(history){
        let where = timeMachine(count, unit);
        where = where.format("YYYY-MM-DDTHH:mm:ss.SSS[Z]");
        let koef = countSamplesRange(count,unit);
        if(unit === "h" && count <= 12){
            sqlVar.push("strftime('%Y-%m-%d %H:%M', added, 'localtime') as added");
            sql = `SELECT ${sqlVar.join()} from Measurements WHERE added > '${where}' ORDER BY added`;
        }else{
            let vars = sqlVar.map(x => "ROUND(AVG(" + x + ")) as " + x );
            vars.push("strftime('%Y-%m-%d %H:%M', added, 'localtime') as added");
            sql = `SELECT ${vars.join()}
                    FROM (SELECT added, ${sqlVar.join()} from Measurements WHERE added > '${where}' ORDER BY added )
                    GROUP BY strftime('%s', added ,'localtime') / ${koef}`;
        }
    }else{
        sqlVar.push("strftime('%Y-%m-%d %H:%M', added,'localtime') as added");
        sql = `SELECT ${sqlVar.join()} from Measurements ORDER BY added`;
    }

    try {
        ret = await db.all(sql);
    }catch (error) {
        return res.status(500).json({error: error.message})
    }
    if(ret){
        res.json({
            status: 'success',
            data: ret
        });
    }else {
        res.status(404).json({error: "No data in DB"});
    }
};

const getDates = async (req, res) => {
    let sql = `SELECT strftime('%Y-%m-%d', added, 'localtime') as added
     FROM (SELECT added FROM Measurements ORDER BY added DESC)
     GROUP BY strftime('%Y-%m-%d', added ,'localtime') ORDER BY added DESC LIMIT 8`;
    try {
        ret = await db.all(sql);
    }catch (error) {
        return res.status(500).json({error: error.message})
    }
    if(ret){
        res.json({
            status: 'success',
            data: ret
        });
    }else {
        res.status(404).json({error: "No data in DB"});
    }
};

app.use(json());
app.use(cors());
app.use(addStatus);
app.use(jsonSend);
app.use(history());
app.use(serve);

app.get(apiUrl + '/ping', ping);
app.post(apiUrl + '/measurements', addMeasurements);
app.get(apiUrl + '/measurements', getMeasurements);
app.get(apiUrl + '/measurements/:type', getValues);
app.get(apiUrl + '/measurements/:type/:history', getValues);
app.get(apiUrl + '/', getLastMeasurements);
app.get(apiUrl + '/dates', getDates);


const main = async () => {
    try {
        db = await Database.open(join(__dirname, "db", "app.db"));
    } catch (error) {
        throw Error(error.message);
    }

    const tableCheckQuery = `select count(name) as meas from sqlite_master where type='table' and name='${tableName}'`;
    try {
        ret = await db.get(tableCheckQuery);
    }catch (error) {
        throw Error(error.message);
    }

    if(ret.meas === 0){
        const createQuery = `CREATE TABLE '${tableName}' (
            'id' INTEGER PRIMARY KEY AUTOINCREMENT,
            'co2' INTEGER,
            'bmp_pressure' INTEGER,
            'bmp_temp' INTEGER,
            'hdc_temp' INTEGER,
            'hdc_hum' INTEGER,
            'added' DATETIME NOT NULL
        )`;
        try {
            db.run(createQuery);
        } catch (error) {
            throw Error('Could not create table')
        }
    }
    app.listen(PORT, err => {
        if (err) throw err;
        console.log(`> Running on localhost:${PORT}`);
    });
};



main();
