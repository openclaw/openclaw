const sql = require("mssql");
const ExcelJS = require("exceljs");
const path = require("path");

const config = {
  server: "192.168.3.250",
  user: "OpenClaw_Reader",
  password: "SafePass_2026!",
  database: "htjx2021",
  options: { encrypt: false, trustServerCertificate: true },
  connectionTimeout: 10000,
  requestTimeout: 60000,
};

async function main() {
  await sql.connect(config);

  // Get undelivered orders for customer A0013 (拓富普)
  const result = await sql.query(`
    SELECT 
      v.voucher_no AS 订单号,
      v.voucher_date AS 订单日期,
      vi.res_id AS 物料编码,
      r.res_name AS 物料名称,
      r.res_spec AS 规格型号,
      vi.inp_num AS 订单数量,
      vi.total_amount/100.0 AS 订单金额,
      ISNULL(d.delivered_qty, 0) AS 已交数量,
      vi.inp_num - ISNULL(d.delivered_qty, 0) AS 未交数量
    FROM ebs_v v 
    JOIN ebs_vr_item vi ON v.voucher_id = vi.voucher_id 
    JOIN ebs_vr vr ON v.voucher_id = vr.voucher_id 
    LEFT JOIN res r ON vi.res_id = r.res_id
    LEFT JOIN (
      SELECT voucher_no, res_id, SUM(inp_num) as delivered_qty 
      FROM eba_io 
      WHERE eba_id = 'A0013' AND voucher_type = 'BB'
      GROUP BY voucher_no, res_id
    ) d ON v.voucher_no = d.voucher_no AND vi.res_id = d.res_id
    WHERE vr.eba_id = 'A0013' AND v.voucher_type = 'BA' AND v.state = 'B'
    ORDER BY v.voucher_date DESC, v.voucher_no
  `);

  const rows = result.recordset;

  // Create Excel workbook
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("未交订单");

  // Add headers
  worksheet.columns = [
    { header: "订单号", key: "订单号", width: 15 },
    { header: "订单日期", key: "订单日期", width: 12 },
    { header: "物料编码", key: "物料编码", width: 15 },
    { header: "物料名称", key: "物料名称", width: 20 },
    { header: "规格型号", key: "规格型号", width: 40 },
    { header: "订单数量", key: "订单数量", width: 12 },
    { header: "订单金额 (元)", key: "订单金额", width: 15 },
    { header: "已交数量", key: "已交数量", width: 12 },
    { header: "未交数量", key: "未交数量", width: 12 },
  ];

  // Add data rows
  rows.forEach((row) => {
    worksheet.addRow({
      订单号: row.订单号,
      订单日期: row.订单日期,
      物料编码: row.物料编码,
      物料名称: row.物料名称,
      规格型号: row.规格型号,
      订单数量: row.订单数量,
      订单金额: row.订单金额,
      已交数量: row.已交数量,
      未交数量: row.未交数量,
    });
  });

  // Style header row
  worksheet.getRow(1).font = { bold: true };
  worksheet.getRow(1).fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFD3D3D3" },
  };

  // Save file
  const outputPath = path.join(__dirname, "../../output", "拓富普未交订单.xlsx");
  await workbook.xlsx.writeFile(outputPath);

  console.log(outputPath);
  console.log(`Total rows: ${rows.length}`);

  await sql.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
