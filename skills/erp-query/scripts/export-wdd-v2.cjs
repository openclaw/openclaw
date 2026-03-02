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
      WHERE bb_vr.eba_id = 'A0088' AND bb.voucher_type = 'BB' 
        AND bb_item.ref_voucher_type = 'BA' AND bb.state IN ('B','C')
      GROUP BY bb_item.ref_voucher_no, bb_item.res_id
    ) d ON ba.voucher_no = d.ref_voucher_no AND ba_item.res_id = d.res_id
    WHERE vr.eba_id = 'A0088' AND ba.voucher_type = 'BA' AND ba.state = 'B'
      AND ba_item.inp_num - ISNULL(d.delivered_qty, 0) > 0
    ORDER BY ba.voucher_date DESC
  `);

  const rows = result.recordset;
  const colCount = 9;

  const workbook = new ExcelJS.Workbook();
  const ws = workbook.addWorksheet("未交订单");

  // Row 1: Title
  ws.mergeCells(1, 1, 1, colCount);
  const titleCell = ws.getCell("A1");
  titleCell.value = "万达电智能科技（昆山）有限公司 - 未交订单明细";
  titleCell.font = { bold: true, size: 16 };
  titleCell.alignment = { horizontal: "center", vertical: "middle" };
  ws.getRow(1).height = 30;

  // Row 2: Headers
  const headers = [
    "订单号",
    "订单日期",
    "物料编码",
    "物料名称",
    "规格型号",
    "订单数量",
    "订单金额(元)",
    "已交数量",
    "未交数量",
  ];
  const widths = [16, 12, 18, 22, 50, 12, 14, 12, 12];
  headers.forEach((h, i) => {
    const cell = ws.getCell(2, i + 1);
    cell.value = h;
    cell.font = { bold: true };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD3D3D3" } };
    cell.alignment = { horizontal: "center" };
    cell.border = {
      top: { style: "thin" },
      bottom: { style: "thin" },
      left: { style: "thin" },
      right: { style: "thin" },
    };
    ws.getColumn(i + 1).width = widths[i];
  });

  // Data rows
  let totalOrderQty = 0,
    totalAmount = 0,
    totalDelivered = 0,
    totalUndelivered = 0;
  rows.forEach((row, idx) => {
    const r = idx + 3;
    const vals = [
      row.voucher_no,
      row.voucher_date,
      row.res_id,
      row.res_name,
      row.res_spec,
      row.order_qty,
      row.amount,
      row.delivered,
      row.undelivered,
    ];
    vals.forEach((v, i) => {
      const cell = ws.getCell(r, i + 1);
      cell.value = v;
      cell.border = {
        top: { style: "thin" },
        bottom: { style: "thin" },
        left: { style: "thin" },
        right: { style: "thin" },
      };
    });
    totalOrderQty += row.order_qty;
    totalAmount += row.amount;
    totalDelivered += row.delivered;
    totalUndelivered += row.undelivered;
  });

  // Total row
  const totalRow = rows.length + 3;
  ws.mergeCells(totalRow, 1, totalRow, 5);
  const totalLabelCell = ws.getCell(totalRow, 1);
  totalLabelCell.value = "合  计";
  totalLabelCell.font = { bold: true };
  totalLabelCell.alignment = { horizontal: "center" };

  const totalVals = [
    null,
    null,
    null,
    null,
    null,
    totalOrderQty,
    Math.round(totalAmount * 100) / 100,
    totalDelivered,
    totalUndelivered,
  ];
  totalVals.forEach((v, i) => {
    const cell = ws.getCell(totalRow, i + 1);
    if (v !== null) {
      cell.value = v;
      cell.font = { bold: true };
    }
    cell.border = {
      top: { style: "thin" },
      bottom: { style: "thin" },
      left: { style: "thin" },
      right: { style: "thin" },
    };
  });

  const outputPath = path.join(__dirname, "../../output", "万达电未交订单.xlsx");
  await workbook.xlsx.writeFile(outputPath);
  console.log(outputPath);
  console.log("Total rows: " + rows.length);

  await sql.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
