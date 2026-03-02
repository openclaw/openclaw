// ERP Query Helper - runs SQL against htjx2021 database
// Usage: node query.cjs "SELECT TOP 10 * FROM eba"
const sql = require("/Users/haruki/.openclaw/workspace/node_modules/mssql");
const { enforceDirectAccessGuard } = require("./acl-guard.cjs");

const config = {
  server: "192.168.3.250",
  user: "OpenClaw_Reader",
  password: "SafePass_2026!",
  database: "htjx2021",
  options: { encrypt: false, trustServerCertificate: true },
  connectionTimeout: 10000,
  requestTimeout: 60000,
  pool: {
    max: 3,
    min: 0,
    idleTimeoutMillis: 30000,
  },
};

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 2000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

(async () => {
  const argv = enforceDirectAccessGuard(process.argv.slice(2));
  const query = argv[0];
  if (!query) {
    console.error('Usage: node query.cjs "SQL QUERY"');
    process.exit(1);
  }

  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    try {
      const pool = await sql.connect(config);
      const result = await pool.request().query(query);
      if (result.recordset && result.recordset.length > 0) {
        console.log("Rows: " + result.recordset.length);
        result.recordset.forEach((r) => console.log(JSON.stringify(r)));
      } else {
        console.log("No results");
      }
      await pool.close();
      return;
    } catch (e) {
      const isRetryable =
        e.code === "ETIMEOUT" ||
        e.code === "ESOCKET" ||
        e.code === "ECONNREFUSED" ||
        e.code === "ECONNRESET" ||
        (e.message && e.message.includes("Connection lost"));

      if (isRetryable && attempt <= MAX_RETRIES) {
        console.error(
          `[重试 ${attempt}/${MAX_RETRIES}] ${e.code || e.message}，${RETRY_DELAY_MS / 1000}s 后重试...`,
        );
        await sleep(RETRY_DELAY_MS);
        try {
          await sql.close();
        } catch (_) {}
        continue;
      }

      // 友好错误提示
      if (e.code === "ETIMEOUT" || e.code === "ESOCKET") {
        console.error(
          "Error: 数据库连接超时。请检查：1) 服务器 192.168.3.250 是否可达 2) 是否连接公司内网/VPN 3) 数据库服务是否运行",
        );
      } else if (e.code === "ECONNREFUSED") {
        console.error("Error: 数据库连接被拒绝。请检查 SQL Server 服务是否启动");
      } else if (e.code === "ELOGIN") {
        console.error("Error: 数据库登录失败，请检查用户名和密码");
      } else {
        console.error("Error:", e.message);
      }
      process.exit(1);
    }
  }
})();
