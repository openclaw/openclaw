import ExcelJS from "exceljs";
import fs from "node:fs/promises";
import type { IssueCategory, IssueRecord, IssueSeverity } from "../types.js";

function toStringValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return `${value}`.trim();
  }
  if (typeof value === "object") {
    const candidate = value as {
      text?: unknown;
      richText?: Array<{ text?: unknown }>;
      result?: unknown;
    };
    if (typeof candidate.text === "string") {
      return candidate.text.trim();
    }
    if (Array.isArray(candidate.richText)) {
      return candidate.richText
        .map((part) => (typeof part.text === "string" ? part.text : ""))
        .join("")
        .trim();
    }
    if (typeof candidate.result === "string") {
      return candidate.result.trim();
    }
  }
  return JSON.stringify(value).trim();
}

export async function readIssuesReport(xlsxPath: string): Promise<IssueRecord[]> {
  try {
    await fs.access(xlsxPath);
  } catch {
    throw new Error(`XLSX report file not found: ${xlsxPath}`);
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(xlsxPath);

  const sheet = workbook.getWorksheet("Issues");
  if (!sheet) {
    throw new Error(`Worksheet "Issues" not found in: ${xlsxPath}`);
  }

  const out: IssueRecord[] = [];
  const lastRow = sheet.rowCount;
  for (let rowNo = 2; rowNo <= lastRow; rowNo += 1) {
    const row = sheet.getRow(rowNo);

    const issueId = toStringValue(row.getCell(1).value);
    const article = toStringValue(row.getCell(2).value);
    const clause = toStringValue(row.getCell(3).value);
    const category = toStringValue(row.getCell(4).value).toUpperCase() as IssueCategory;
    const severity = toStringValue(row.getCell(5).value).toUpperCase() as IssueSeverity;
    const arabicExcerpt = toStringValue(row.getCell(6).value).normalize("NFC");
    const englishExcerpt = toStringValue(row.getCell(7).value);
    const correction = toStringValue(row.getCell(8).value);
    const notes = toStringValue(row.getCell(9).value);
    const applyRaw = toStringValue(row.getCell(10).value).toLowerCase();

    if (!issueId || !englishExcerpt) {
      continue;
    }
    if (applyRaw !== "yes") {
      continue;
    }

    out.push({
      issueId,
      article,
      clause,
      category,
      arabicExcerpt,
      englishExcerpt,
      correction,
      severity,
      notes,
      apply: true,
    });
  }

  return out;
}
