import ExcelJS from "exceljs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readIssuesReport } from "./xlsx-reader.js";

async function makeWorkbook(filePath: string) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Issues");
  ws.addRow([
    "Issue ID",
    "Article",
    "Clause",
    "Category",
    "Severity",
    "Arabic Source Text",
    "Current English Text",
    "Suggested Correction",
    "Notes",
    "Apply?",
  ]);
  ws.addRow(["ISS-001", "1", "", "GRAMMAR", "LOW", "أ", "x", "y", "n", "Yes"]);
  ws.addRow(["ISS-002", "2", "", "GRAMMAR", "LOW", "أ", "x", "y", "n", "NO"]);
  ws.addRow(["", "3", "", "GRAMMAR", "LOW", "أ", "x", "y", "n", "yes"]);
  ws.addRow(["ISS-003", "4", "", "GRAMMAR", "LOW", "أ", "", "y", "n", "YES"]);
  await wb.xlsx.writeFile(filePath);
}

describe("xlsx-reader", () => {
  it("includes only Apply?=Yes rows (case-insensitive) and skips invalid rows", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lp-xlsx-reader-"));
    const file = path.join(dir, "issues.xlsx");
    await makeWorkbook(file);

    const rows = await readIssuesReport(file);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.issueId).toBe("ISS-001");
  });

  it("throws descriptive error when file is missing", async () => {
    await expect(readIssuesReport("/tmp/does-not-exist.xlsx")).rejects.toThrow(/not found/i);
  });

  it("throws when Issues sheet is missing", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lp-xlsx-reader-nosheet-"));
    const file = path.join(dir, "issues.xlsx");
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("Other");
    await wb.xlsx.writeFile(file);

    await expect(readIssuesReport(file)).rejects.toThrow(/Worksheet "Issues" not found/i);
  });
});
