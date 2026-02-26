import ExcelJS from "exceljs";
import type { IssueRecord } from "../types.js";

const SEVERITY_FILL = {
  HIGH: { type: "pattern", pattern: "solid", fgColor: { argb: "FFFF4444" } },
  MEDIUM: { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFA500" } },
  LOW: { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFFFCC" } },
} as const;

function normalizeArabic(value: string): string {
  return (value ?? "").normalize("NFC");
}

function toUpperText(value: unknown): string {
  if (typeof value === "string") {
    return value.toUpperCase();
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return `${value}`.toUpperCase();
  }
  return "";
}

export async function writeIssuesReport(issues: IssueRecord[], outputPath: string): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Issues");

  sheet.columns = [
    { header: "Issue ID", key: "issueId", width: 14 },
    { header: "Article", key: "article", width: 10 },
    { header: "Clause", key: "clause", width: 12 },
    { header: "Category", key: "category", width: 18 },
    { header: "Severity", key: "severity", width: 10 },
    { header: "Arabic Source Text", key: "arabicSourceText", width: 40 },
    { header: "Current English Text", key: "currentEnglishText", width: 40 },
    { header: "Suggested Correction", key: "suggestedCorrection", width: 40 },
    { header: "Notes", key: "notes", width: 30 },
    { header: "Apply?", key: "apply", width: 10 },
  ];

  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: 1 }];

  for (const issue of issues) {
    sheet.addRow({
      issueId: issue.issueId,
      article: issue.article,
      clause: issue.clause,
      category: issue.category,
      severity: issue.severity,
      arabicSourceText: normalizeArabic(issue.arabicExcerpt),
      currentEnglishText: issue.englishExcerpt,
      suggestedCorrection: issue.correction,
      notes: issue.notes,
      apply: "Yes",
    });
  }

  const lastRow = sheet.rowCount;
  for (let row = 2; row <= lastRow; row += 1) {
    const arabicCell = sheet.getCell(`F${row}`);
    arabicCell.alignment = {
      readingOrder: "rtl",
      horizontal: "right",
      wrapText: true,
    } as unknown as ExcelJS.Alignment;

    for (const col of ["A", "B", "C", "D", "E", "G", "H", "I", "J"]) {
      const cell = sheet.getCell(`${col}${row}`);
      cell.alignment = { wrapText: true } as unknown as ExcelJS.Alignment;
    }

    const severityCell = sheet.getCell(`E${row}`);
    const severity = toUpperText(severityCell.value) as keyof typeof SEVERITY_FILL;
    if (severity in SEVERITY_FILL) {
      severityCell.fill = SEVERITY_FILL[severity] as ExcelJS.Fill;
    }
  }

  await workbook.xlsx.writeFile(outputPath);
}
