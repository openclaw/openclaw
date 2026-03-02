#!/usr/bin/env node
/**
 * ERP Quick Query - 快速查询脚本
 *
 * Usage:
 *   node quick-query.cjs supplier B0069                    # 查供应商未交订单
 *   node quick-query.cjs supplier B0069 --aging           # 按账龄分组
 *   node quick-query.cjs supplier B0069 --recent 10       # 最近 N 条
 *   node quick-query.cjs sql "SELECT TOP 10 * FROM eba"   # 直接 SQL
 *   node quick-query.cjs supplier B0069 --json            # JSON 输出
 */

const sql = require("/Users/haruki/.openclaw/workspace/node_modules/mssql");
const { enforceDirectAccessGuard } = require("./acl-guard.cjs");
const argv = enforceDirectAccessGuard(process.argv.slice(2));

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

async function withRetry(fn, label = "query") {
  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isRetryable =
        err.code === "ETIMEOUT" ||
        err.code === "ESOCKET" ||
        err.code === "ECONNREFUSED" ||
        err.code === "ECONNRESET" ||
        (err.message && err.message.includes("Connection lost"));

      if (isRetryable && attempt <= MAX_RETRIES) {
        console.error(
          `[${label}] 第 ${attempt} 次失败 (${err.code || err.message})，${RETRY_DELAY_MS / 1000}s 后重试...`,
        );
        await sleep(RETRY_DELAY_MS);
        // 重置连接池
        try {
          await sql.close();
        } catch (_) {}
        continue;
      }

      // 不可重试或已用完重试次数
      if (err.code === "ETIMEOUT" || err.code === "ESOCKET") {
        throw new Error(
          `数据库连接超时，请检查：\n1. ERP 服务器 192.168.3.250 是否可达\n2. 是否已连接公司内网/VPN\n3. 数据库服务是否正常运行`,
        );
      } else if (err.code === "ECONNREFUSED") {
        throw new Error(
          `数据库连接被拒绝（192.168.3.250:1433），可能是：\n1. SQL Server 服务未启动\n2. 防火墙阻止了连接\n3. 端口号不正确`,
        );
      } else if (err.code === "ELOGIN") {
        throw new Error(`数据库登录失败，请检查用户名和密码配置`);
      }
      throw err;
    }
  }
}

function printHelp() {
  console.log(`
ERP Quick Query - 快速查询工具

Usage:
  node quick-query.cjs <command> [options]

Commands:
  supplier <sup_id>       查询供应商未交订单（已扣除入库数量）
  sql <query>             执行自定义 SQL

Options:
  --aging                 按账龄分组（>1 年、6-12 月、3-6 月、<3 月）
  --recent <N>            显示最近 N 条订单（默认 5）
  --year <YYYY>           指定年份（默认当年）
  --json                  输出 JSON 格式
  --help                  显示帮助

Examples:
  node quick-query.cjs supplier B0069
  node quick-query.cjs supplier B0069 --aging --json
  node quick-query.cjs supplier B0069 --recent 10 --year 2025
  node quick-query.cjs sql "SELECT TOP 10 * FROM eba"
`);
}

async function querySupplier(supId, options) {
  await withRetry(() => sql.connect(config), "connect");

  const results = {};
  const year = options.year || new Date().getFullYear().toString();
  const yearStart = `${year}0101`;
  const yearEnd = `${year}1231`;

  // 未交订单汇总（采购订单 AA - 已入库 AB = 真实未交）
  const summary = await withRetry(async () => {
    const req = new sql.Request();
    req.input("supId", sql.NVarChar, supId);
    req.input("yearStart", sql.NVarChar, yearStart);
    req.input("yearEnd", sql.NVarChar, yearEnd);
    return req.query(`
      SELECT
        COUNT(DISTINCT aa_v.voucher_no) as total_orders,
        COUNT(*) as total_lines,
        SUM(aa_item.inp_num - ISNULL(ab_sum.in_qty, 0)) as total_qty,
        SUM((aa_item.total_amount/100.0) * (aa_item.inp_num - ISNULL(ab_sum.in_qty, 0)) / NULLIF(aa_item.inp_num, 0)) as total_amount
      FROM ebs_v aa_v
      JOIN ebs_vr aa_vr ON aa_v.voucher_id = aa_vr.voucher_id
      JOIN ebs_vr_item aa_item ON aa_v.voucher_id = aa_item.voucher_id
      LEFT JOIN (
        SELECT ref_voucher_id, res_id, SUM(inp_num) as in_qty
        FROM ebs_vr_item
        WHERE voucher_id IN (SELECT voucher_id FROM ebs_v WHERE voucher_type = 'AB' AND state = 'B')
        AND ref_voucher_type = 'AA'
        GROUP BY ref_voucher_id, res_id
      ) ab_sum ON aa_item.voucher_id = ab_sum.ref_voucher_id AND aa_item.res_id = ab_sum.res_id
      WHERE aa_v.voucher_type = 'AA' AND aa_v.state = 'B'
        AND aa_vr.eba_id = @supId
        AND aa_v.voucher_date >= @yearStart AND aa_v.voucher_date <= @yearEnd
        AND (aa_item.inp_num - ISNULL(ab_sum.in_qty, 0)) > 0
    `);
  }, "summary");

  results.summary = summary.recordset[0];

  // 账龄分析
  if (options.aging) {
    const aging = await withRetry(async () => {
      const req = new sql.Request();
      req.input("supId", sql.NVarChar, supId);
      return req.query(`
        SELECT
          CASE
            WHEN aa_v.voucher_date < CONVERT(varchar(8), DATEADD(year, -1, GETDATE()), 112) THEN '>1 年'
            WHEN aa_v.voucher_date < CONVERT(varchar(8), DATEADD(month, -6, GETDATE()), 112) THEN '6月-1年'
            WHEN aa_v.voucher_date < CONVERT(varchar(8), DATEADD(month, -3, GETDATE()), 112) THEN '3月-6月'
            ELSE '<3 月'
          END as age_group,
          COUNT(*) as line_count,
          SUM(aa_item.inp_num - ISNULL(ab_sum.in_qty, 0)) as qty,
          SUM((aa_item.total_amount/100.0) * (aa_item.inp_num - ISNULL(ab_sum.in_qty, 0)) / NULLIF(aa_item.inp_num, 0)) as amount
        FROM ebs_v aa_v
        JOIN ebs_vr aa_vr ON aa_v.voucher_id = aa_vr.voucher_id
        JOIN ebs_vr_item aa_item ON aa_v.voucher_id = aa_item.voucher_id
        LEFT JOIN (
          SELECT ref_voucher_id, res_id, SUM(inp_num) as in_qty
          FROM ebs_vr_item
          WHERE voucher_id IN (SELECT voucher_id FROM ebs_v WHERE voucher_type = 'AB' AND state = 'B')
          AND ref_voucher_type = 'AA'
          GROUP BY ref_voucher_id, res_id
        ) ab_sum ON aa_item.voucher_id = ab_sum.ref_voucher_id AND aa_item.res_id = ab_sum.res_id
        WHERE aa_v.voucher_type = 'AA' AND aa_v.state = 'B'
          AND aa_vr.eba_id = @supId
          AND (aa_item.inp_num - ISNULL(ab_sum.in_qty, 0)) > 0
        GROUP BY
          CASE
            WHEN aa_v.voucher_date < CONVERT(varchar(8), DATEADD(year, -1, GETDATE()), 112) THEN '>1 年'
            WHEN aa_v.voucher_date < CONVERT(varchar(8), DATEADD(month, -6, GETDATE()), 112) THEN '6月-1年'
            WHEN aa_v.voucher_date < CONVERT(varchar(8), DATEADD(month, -3, GETDATE()), 112) THEN '3月-6月'
            ELSE '<3 月'
          END
        ORDER BY age_group
      `);
    }, "aging");

    results.aging = aging.recordset;
  }

  // 未交订单明细
  const recentCount = options.recent || 5;
  const allOrders = await withRetry(async () => {
    const req = new sql.Request();
    req.input("supId", sql.NVarChar, supId);
    req.input("yearStart", sql.NVarChar, yearStart);
    req.input("yearEnd", sql.NVarChar, yearEnd);
    return req.query(`
      SELECT TOP ${parseInt(recentCount)}
        aa_v.voucher_no,
        aa_v.voucher_date,
        r.res_name,
        r.res_model,
        aa_item.inp_num as order_qty,
        ISNULL(ab_sum.in_qty, 0) as received_qty,
        aa_item.inp_num - ISNULL(ab_sum.in_qty, 0) as outstanding_qty,
        (aa_item.total_amount/100.0) * (aa_item.inp_num - ISNULL(ab_sum.in_qty, 0)) / NULLIF(aa_item.inp_num, 0) as outstanding_amount
      FROM ebs_v aa_v
      JOIN ebs_vr aa_vr ON aa_v.voucher_id = aa_vr.voucher_id
      JOIN ebs_vr_item aa_item ON aa_v.voucher_id = aa_item.voucher_id
      JOIN res r ON aa_item.res_id = r.res_id
      LEFT JOIN (
        SELECT ref_voucher_id, res_id, SUM(inp_num) as in_qty
        FROM ebs_vr_item
        WHERE voucher_id IN (SELECT voucher_id FROM ebs_v WHERE voucher_type = 'AB' AND state = 'B')
        AND ref_voucher_type = 'AA'
        GROUP BY ref_voucher_id, res_id
      ) ab_sum ON aa_item.voucher_id = ab_sum.ref_voucher_id AND aa_item.res_id = ab_sum.res_id
      WHERE aa_v.voucher_type = 'AA' AND aa_v.state = 'B'
        AND aa_vr.eba_id = @supId
        AND aa_v.voucher_date >= @yearStart AND aa_v.voucher_date <= @yearEnd
        AND (aa_item.inp_num - ISNULL(ab_sum.in_qty, 0)) > 0
      ORDER BY aa_v.voucher_date DESC, aa_v.voucher_no
    `);
  }, "orders");

  results.recent = allOrders.recordset;

  await sql.close();
  return results;
}

async function runSql(query) {
  await withRetry(() => sql.connect(config), "connect");
  const result = await withRetry(() => sql.query(query), "sql");
  await sql.close();
  return result.recordset;
}

async function main() {
  if (argv.length === 0 || argv.includes("--help")) {
    printHelp();
    return;
  }

  const command = argv[0];
  const yearIdx = argv.indexOf("--year");
  const options = {
    aging: argv.includes("--aging"),
    recent: parseInt(argv[argv.indexOf("--recent") + 1]) || 5,
    year: yearIdx >= 0 ? argv[yearIdx + 1] : null,
    json: argv.includes("--json"),
  };

  try {
    let results;

    if (command === "supplier") {
      const supId = argv[1];
      if (!supId) {
        console.log("Error: 请指定供应商 ID");
        return;
      }

      results = await querySupplier(supId, options);

      if (options.json) {
        console.log(JSON.stringify(results, null, 2));
      } else {
        const s = results.summary;
        console.log("\n=== 供应商未交订单汇总 ===");
        console.log("未交订单数:", s.total_orders);
        console.log("未交明细行:", s.total_lines);
        console.log("未交总数量:", s.total_qty);
        console.log("未交总金额：¥" + (s.total_amount ? s.total_amount.toFixed(2) : "0.00"));

        if (options.aging) {
          console.log("\n=== 账龄分析 ===");
          results.aging.forEach((row) => {
            console.log(
              row.age_group +
                ": " +
                row.line_count +
                "行，数量 " +
                row.qty +
                "，¥" +
                (row.amount ? row.amount.toFixed(2) : "0.00"),
            );
          });
        }

        console.log("\n=== 最近 " + options.recent + " 条未交明细 ===");
        results.recent.forEach((row) => {
          console.log(
            row.voucher_no +
              " (" +
              row.voucher_date +
              ") | " +
              (row.res_name || "N/A") +
              " | " +
              "订:" +
              row.order_qty +
              " 交:" +
              row.received_qty +
              " 未交:" +
              row.outstanding_qty +
              " | ¥" +
              (row.outstanding_amount ? row.outstanding_amount.toFixed(2) : "0.00"),
          );
        });
      }
    } else if (command === "sql") {
      const query = argv.slice(1).join(" ").replace(/--.*$/, "");
      if (!query.trim()) {
        console.log("Error: 请指定 SQL 查询");
        return;
      }

      results = await runSql(query);

      if (options.json) {
        console.log(JSON.stringify(results, null, 2));
      } else {
        console.log("Rows:", results.length);
        results.forEach((row) => console.log(JSON.stringify(row)));
      }
    } else {
      console.log("Unknown command:", command);
      printHelp();
    }
  } catch (err) {
    console.error("Error:", err.message);
    process.exit(1);
  }
}

main();
