const sql = require('mssql');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

const argv = yargs(hideBin(process.argv)).argv;

const config = {
    user: argv.user,
    password: argv.password,
    server: argv.server,
    database: 'master', // Start in master, switch as needed
    options: {
        encrypt: false,
        trustServerCertificate: true,
        requestTimeout: 30000 // 30s timeout for heavy queries
    }
};

async function run() {
    const action = argv._[0];

    try {
        const pool = await sql.connect(config);

        if (action === 'status') {
            await runStatus(pool);
        } else if (action === 'analyze') {
            await runAnalyze(pool);
        } else {
            console.log("Unknown action. Use 'status' or 'analyze'.");
        }

        await pool.close();
    } catch (err) {
        console.error("Error:", err.message);
        process.exit(1);
    }
}

async function runStatus(pool) {
    const result = await pool.request().query(`
        SELECT 
            @@VERSION as Version,
            sqlserver_start_time as StartTime,
            (SELECT COUNT(*) FROM sys.databases WHERE state_desc = 'ONLINE') as OnlineDBs,
            (SELECT cpu_count FROM sys.dm_os_sys_info) as LogicalCPUs,
            (SELECT physical_memory_kb/1024 FROM sys.dm_os_sys_info) as PhysicalMemoryMB
        FROM sys.dm_os_sys_info
    `);
    console.log(JSON.stringify(result.recordset[0], null, 2));
}

async function runAnalyze(pool) {
    const report = {
        meta: {
            timestamp: new Date(),
            server: config.server
        },
        system: {},
        performance: {},
        optimization: {}
    };

    console.error("Starting deep analysis... (this may take a moment)");

    // --- SYSTEM INFO ---
    const sysInfo = await pool.request().query(`
        SELECT 
            cpu_count AS LogicalCPUs, 
            scheduler_count, 
            physical_memory_kb/1024 AS PhysicalRAM_MB,
            virtual_memory_kb/1024 AS VirtualRAM_MB,
            sqlserver_start_time
        FROM sys.dm_os_sys_info WITH (NOLOCK) OPTION (RECOMPILE);
    `);
    report.system.info = sysInfo.recordset[0];

    // --- WAIT STATS (Top 10 - Excluding benign waits) ---
    // Adapted from Glenn Berry's Diagnostic Queries
    const waits = await pool.request().query(`
        WITH Waits AS (
            SELECT 
                wait_type, 
                wait_time_ms / 1000.0 AS WaitS, 
                (wait_time_ms - signal_wait_time_ms) / 1000.0 AS ResourceS, 
                signal_wait_time_ms / 1000.0 AS SignalS, 
                waiting_tasks_count AS WaitCount, 
                100.0 * wait_time_ms / SUM(wait_time_ms) OVER() AS Pct,
                ROW_NUMBER() OVER(ORDER BY wait_time_ms DESC) AS RowNum
            FROM sys.dm_os_wait_stats WITH (NOLOCK)
            WHERE wait_type NOT IN (
                N'BROKER_EVENTHANDLER', N'BROKER_RECEIVE_WAITFOR', N'BROKER_TASK_STOP', N'BROKER_TO_FLUSH', N'BROKER_TRANSMITTER', N'CHECKPOINT_QUEUE', N'CHKPT', N'CLR_AUTO_EVENT', N'CLR_MANUAL_EVENT', N'CLR_SEMAPHORE', 
                N'CXCONSUMER', N'DBMIRROR_DBM_EVENT', N'DBMIRROR_EVENTS_QUEUE', N'DBMIRROR_WORKER_QUEUE', N'DBMIRRORING_CMD', N'DIRTY_PAGE_POLL', N'DISPATCHER_QUEUE_SEMAPHORE', N'EXECSYNC', N'FSAGENT', 
                N'FT_IFTS_SCHEDULER_IDLE_WAIT', N'FT_IFTSHC_MUTEX', N'HADR_CLUSAPI_CALL', N'HADR_FILESTREAM_IOMGR_IOCOMPLETION', N'HADR_LOGCAPTURE_WAIT', N'HADR_NOTIFICATION_DEQUEUE', N'HADR_TIMER_TASK', N'HADR_WORK_QUEUE', 
                N'KSOURCE_WAKEUP', N'LAZYWRITER_SLEEP', N'LOGMGR_QUEUE', N'MEMORY_ALLOCATION_EXT', N'ONDEMAND_TASK_QUEUE', N'PARALLEL_REDO_DRAIN_WORKER', N'PARALLEL_REDO_LOG_CACHE', N'PARALLEL_REDO_TRAN_LIST', 
                N'PARALLEL_REDO_WORKER_SYNC', N'PARALLEL_REDO_WORKER_WAIT_WORK', N'PREEMPTIVE_OS_FLUSHFILEBUFFERS', N'PREEMPTIVE_XE_GETTARGETSTATE', N'PWAIT_ALL_COMPONENTS_INITIALIZED', N'PWAIT_DIRECTLOGCONSUMER_GETNEXT', 
                N'QDS_PERSIST_TASK_MAIN_LOOP_SLEEP', N'QDS_ASYNC_QUEUE', N'QDS_CLEANUP_STALE_QUERIES_TASK_MAIN_LOOP_SLEEP', N'QDS_SHUTDOWN_QUEUE', N'REDO_THREAD_PENDING_WORK', N'REQUEST_FOR_DEADLOCK_SEARCH', 
                N'RESOURCE_QUEUE', N'SERVER_IDLE_CHECK', N'SLEEP_BPOOL_FLUSH', N'SLEEP_DBSTARTUP', N'SLEEP_DCOMSTARTUP', N'SLEEP_MASTERDBREADY', N'SLEEP_MASTERMDREADY', N'SLEEP_MASTERUPGRADED', N'SLEEP_MSQLDQ', 
                N'SLEEP_SYSTEMTASK', N'SLEEP_TASK', N'SLEEP_TEMPDBSTARTUP', N'SNI_HTTP_ACCEPT', N'SOS_WORK_DISPATCHER', N'SP_SERVER_DIAGNOSTICS_SLEEP', N'SQLTRACE_BUFFER_FLUSH', N'SQLTRACE_INCREMENTAL_FLUSH_SLEEP', 
                N'SQLTRACE_WAIT_ENTRIES', N'VDI_CLIENT_OTHER', N'WAIT_FOR_RESULTS', N'WAITFOR', N'WAITFOR_TASKSHUTDOWN', N'WAIT_XTP_RECOVERY', N'WAIT_XTP_HOST_WAIT', N'WAIT_XTP_OFFLINE_CKPT_NEW_LOG', 
                N'WAIT_XTP_CKPT_CLOSE', N'XE_DISPATCHER_JOIN', N'XE_DISPATCHER_WAIT', N'XE_TIMER_EVENT'
            )
        )
        SELECT TOP 10 * FROM Waits WHERE Pct > 0 ORDER BY RowNum OPTION (RECOMPILE);
    `);
    report.performance.waitStats = waits.recordset;

    // --- IO LATENCY (Slow Files) ---
    const ioLatency = await pool.request().query(`
        SELECT TOP 10 
            DB_NAME(fs.database_id) AS [DatabaseName], 
            mf.physical_name, 
            io_stall_read_ms / NULLIF(num_of_reads, 0) AS AvgReadLatency, 
            io_stall_write_ms / NULLIF(num_of_writes, 0) AS AvgWriteLatency,
            num_of_reads,
            num_of_writes
        FROM sys.dm_io_virtual_file_stats(NULL, NULL) AS fs
        INNER JOIN sys.master_files AS mf WITH (NOLOCK)
        ON fs.database_id = mf.database_id AND fs.[file_id] = mf.[file_id]
        ORDER BY AvgReadLatency + AvgWriteLatency DESC OPTION (RECOMPILE);
    `);
    report.performance.ioLatency = ioLatency.recordset;

    // --- MISSING INDEXES (High Impact) ---
    const missingIndexes = await pool.request().query(`
        SELECT TOP 10
            d.statement as TableName,
            gs.avg_total_user_cost * gs.avg_user_impact * (gs.user_seeks + gs.user_scans) as Impact,
            'CREATE INDEX [IX_' + OBJECT_NAME(d.object_id, d.database_id) + '_' + REPLACE(REPLACE(REPLACE(ISNULL(d.equality_columns,''),', ','_'),'[',''),']','') + '] ON ' + d.statement + ' (' + ISNULL(d.equality_columns,'') + CASE WHEN d.equality_columns IS NOT NULL AND d.inequality_columns IS NOT NULL THEN ',' ELSE '' END + ISNULL(d.inequality_columns,'') + ')' + ISNULL(' INCLUDE (' + d.included_columns + ')', '') as CreateStatement
        FROM sys.dm_db_missing_index_groups g
        JOIN sys.dm_db_missing_index_group_stats gs ON gs.group_handle = g.index_group_handle
        JOIN sys.dm_db_missing_index_details d ON g.index_handle = d.index_handle
        ORDER BY Impact DESC OPTION (RECOMPILE);
    `);
    report.optimization.missingIndexes = missingIndexes.recordset;

    // --- EXPENSIVE QUERIES (CPU) ---
    const topCpu = await pool.request().query(`
        SELECT TOP 10
            SUBSTRING(qt.text, (qs.statement_start_offset/2)+1,
                ((CASE qs.statement_end_offset
                    WHEN -1 THEN DATALENGTH(qt.text)
                    ELSE qs.statement_end_offset
                END - qs.statement_start_offset)/2)+1) AS SQLText,
            qs.total_worker_time/1000 AS TotalCPU_ms,
            qs.execution_count,
            qs.total_worker_time/qs.execution_count/1000 AS AvgCPU_ms,
            qp.query_plan
        FROM sys.dm_exec_query_stats qs
        CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) qt
        OUTER APPLY sys.dm_exec_query_plan(qs.plan_handle) qp
        ORDER BY qs.total_worker_time DESC OPTION (RECOMPILE);
    `);
    // We strip query_plan XML for JSON output size reasons, or keep it if needed.
    // For now, let's keep it but be mindful of size.
    report.performance.topCpuQueries = topCpu.recordset.map(r => {
        delete r.query_plan; // Remove huge XML for cleaner console output
        return r;
    });

    // --- SQL ERROR LOG (Last 5 critical errors) ---
    // Note: requires securityadmin or sysadmin
    try {
        const errorLog = await pool.request().query(`
            CREATE TABLE #ErrorLog (LogDate DATETIME, ProcessInfo VARCHAR(10), Text VARCHAR(MAX));
            INSERT INTO #ErrorLog EXEC sp_readerrorlog 0, 1, 'Error'; 
            SELECT TOP 5 * FROM #ErrorLog ORDER BY LogDate DESC;
            DROP TABLE #ErrorLog;
        `);
        report.system.recentErrors = errorLog.recordset;
    } catch (e) {
        report.system.recentErrors = "Could not read error log (permissions?)";
    }

    console.log(JSON.stringify(report, null, 2));
}

run();
