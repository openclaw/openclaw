const sql = require('mssql');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

const argv = yargs(hideBin(process.argv)).argv;

const config = {
    user: argv.user,
    password: argv.password,
    server: argv.server,
    database: 'master',
    options: {
        encrypt: false, // Default for internal networks
        trustServerCertificate: true
    }
};

async function run() {
    const action = argv._[0];

    try {
        const pool = await sql.connect(config);

        if (action === 'status') {
            const result = await pool.request().query(`
                SELECT 
                    @@VERSION as Version,
                    sqlserver_start_time as StartTime,
                    (SELECT COUNT(*) FROM sys.databases WHERE state_desc = 'ONLINE') as OnlineDBs
                FROM sys.dm_os_sys_info
            `);
            console.log(JSON.stringify(result.recordset[0], null, 2));
        } 
        
        else if (action === 'analyze') {
            const report = {};

            // 1. High CPU Queries
            const cpuQueries = await pool.request().query(`
                SELECT TOP 5
                    SUBSTRING(qt.text, (qs.statement_start_offset/2)+1,
                        ((CASE qs.statement_end_offset
                            WHEN -1 THEN DATALENGTH(qt.text)
                            ELSE qs.statement_end_offset
                        END - qs.statement_start_offset)/2)+1) AS SQLText,
                    qs.total_worker_time/1000 AS TotalCPU_ms,
                    qs.execution_count,
                    qs.total_worker_time/qs.execution_count/1000 AS AvgCPU_ms
                FROM sys.dm_exec_query_stats qs
                CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) qt
                ORDER BY qs.total_worker_time DESC
            `);
            report.topCpuQueries = cpuQueries.recordset;

            // 2. Missing Indexes
            const missingIndexes = await pool.request().query(`
                SELECT TOP 5
                    d.statement as TableName,
                    gs.avg_total_user_cost * gs.avg_user_impact * (gs.user_seeks + gs.user_scans) as Impact,
                    'CREATE INDEX [IX_' + OBJECT_NAME(d.object_id, d.database_id) + '_' + REPLACE(REPLACE(REPLACE(ISNULL(d.equality_columns,''),', ','_'),'[',''),']','') + '] ON ' + d.statement + ' (' + ISNULL(d.equality_columns,'') + CASE WHEN d.equality_columns IS NOT NULL AND d.inequality_columns IS NOT NULL THEN ',' ELSE '' END + ISNULL(d.inequality_columns,'') + ')' + ISNULL(' INCLUDE (' + d.included_columns + ')', '') as CreateStatement
                FROM sys.dm_db_missing_index_groups g
                JOIN sys.dm_db_missing_index_group_stats gs ON gs.group_handle = g.index_group_handle
                JOIN sys.dm_db_missing_index_details d ON g.index_handle = d.index_handle
                ORDER BY Impact DESC
            `);
            report.missingIndexes = missingIndexes.recordset;

            console.log(JSON.stringify(report, null, 2));
        }

        await pool.close();
    } catch (err) {
        console.error("Error:", err.message);
        process.exit(1);
    }
}

run();
