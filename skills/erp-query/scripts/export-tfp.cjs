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

  const result = await sql.query(`
    SELECT 
      ba.voucher_no, ba.voucher_date, ba_item.res_id, r.res_name, r.res_spec,
      ba_item.inp_num as order_qty, ba_item.total_amount/100.0 as amount,
      ISNULL(d.delivered_qty, 0) as delivered,
      ba_item.inp_num - ISNULL(d.delivered_qty, 0) as undelivered
    FROM ebs_v ba 
    JOIN ebs_vr_item ba_item ON ba.voucher_id = ba_item.voucher_id 
    JOIN ebs_vr vr ON ba.voucher_id = vr.voucher_id 
    LEFT JOIN res r ON ba_item.res_id = r.res_id
    LEFT JOIN (
      SELECT bb_item.ref_voucher_no, bb_item.res_id, SUM(bb_item.inp_num) as delivered_qty 
      FROM ebs_vr_item bb_item 
      JOIN ebs_v bb ON bb_item.voucher_id = bb.voucher_id 
      JOIN ebs_vr bb_vr ON bb.voucher_id = bb_vr.voucher_id 
      WHERE bb_vr.eba_id = 'A0013' AND bb.voucher_type = 'BB' 
        AND bb_item.ref_voucher_type = 'BA' AND bb.state IN ('B','C')
      GROUP BY bb_item.ref_voucher_no, bb_item.res_id
    ) d ON ba.voucher_no = d.ref_voucher_no AND ba_item.res_id = d.res_id
    WHERE vr.eba_id = 'A0013' AND ba.voucher_type = 'BA' AND ba.state = 'B'
      AND ba_item.inp_num - ISNULL(d.delivered_qty, 0) > 0
    ORDER BY ba.voucher_date DESC
  `);

  const rows = result.recordset;

  const workbook = new ExcelJS.Workbook();
  const ws = workbook.addWorksheet("未交订单");

  ws.columns = [
    { header: "订单号", key: "voucher_no", width: 16 },
    { header: "订单日期", key: "voucher_date", width: 12 },
    { header: "物料编码", key: "res_id", width: 18 },
    { header: "物料名称", key: "res_name", width: 22 },
    { header: "规格型号", key: "res_spec", width: 50 },
    { header: "订单数量", key: "order_qty", width: 12 },
    { header: "订单金额(元)", key: "amount", width: 14 },
    { header: "已交数量", key: "delivered", width: 12 },
    { header: "未交数量", key: "undelivered", width: 12 },
  ];

  rows.forEach((row) => ws.addRow(row));

  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD3D3D3" } };

  const outputPath = path.join(__dirname, "../../output", "拓富普未交订单.xlsx");
  await workbook.xlsx.writeFile(outputPath);
  console.log(outputPath);
  console.log("Total rows: " + rows.length);

  await sql.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
