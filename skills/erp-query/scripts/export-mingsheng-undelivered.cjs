const sql = require("/Users/haruki/.openclaw/workspace/node_modules/mssql");
const fs = require("fs");
const path = require("path");

const config = {
  server: "192.168.3.250",
  user: "OpenClaw_Reader",
  password: "SafePass_2026!",
  database: "htjx2021",
  options: { encrypt: false, trustServerCertificate: true },
  connectionTimeout: 15000,
  requestTimeout: 120000, // 增加超时时间到 120 秒
};

async function main() {
  await sql.connect(config);

  // 查询明胜（B0069）的未交采购订单
  const result = await sql.query(`
    SELECT 
      aa_v.voucher_no AS 订单号,
      aa_v.voucher_date AS 订单日期,
      r.res_name AS 物料名称,
      r.res_model AS 规格型号,
      aa_item.inp_num AS 订单数量,
      ISNULL(ab_sum.in_qty, 0) AS 已交数量,
      aa_item.inp_num - ISNULL(ab_sum.in_qty, 0) AS 未交数量,
      (aa_item.total_amount/100.0) * (aa_item.inp_num - ISNULL(ab_sum.in_qty, 0)) / NULLIF(aa_item.inp_num, 0) AS 未交金额
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
      AND aa_vr.eba_id = 'B0069'
      AND aa_v.voucher_date >= '20260101' AND aa_v.voucher_date <= '20261231'
      AND (aa_item.inp_num - ISNULL(ab_sum.in_qty, 0)) > 0
    ORDER BY aa_v.voucher_date DESC, aa_v.voucher_no, r.res_name
  `);

  const rows = result.recordset;

  // 创建 CSV 内容
  const headers = [
    "订单号",
    "订单日期",
    "物料名称",
    "规格型号",
    "订单数量",
    "已交数量",
    "未交数量",
    "未交金额",
  ];
  const csvLines = [headers.join(",")];

  rows.forEach((row) => {
    const line = [
      row.订单号,
      row.订单日期,
      `"${(row.物料名称 || "").replace(/"/g, '""')}"`,
      `"${(row.规格型号 || "").replace(/"/g, '""')}"`,
      row.订单数量,
      row.已交数量,
      row.未交数量,
      row.未交金额 ? row.未交金额.toFixed(2) : "0.00",
    ];
    csvLines.push(line.join(","));
  });

  // 保存 CSV 文件
  const outputDir = path.join(__dirname, "../../../workspace");
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, -5);
  const outputPath = path.join(outputDir, `明胜未交采购订单_${timestamp}.csv`);

  // 添加 BOM 以支持 Excel 正确显示中文
  const BOM = "\uFEFF";
  fs.writeFileSync(outputPath, BOM + csvLines.join("\n"), "utf8");

  console.log(`导出成功: ${outputPath}`);
  console.log(`总行数: ${rows.length}`);

  await sql.close();
}

main().catch((err) => {
  console.error("错误:", err.message);
  process.exit(1);
});
