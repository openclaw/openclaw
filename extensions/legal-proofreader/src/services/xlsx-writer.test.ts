import ExcelJS from "exceljs";
import JSZip from "jszip";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { IssueRecord } from "../types.js";
import { writeIssuesReport } from "./xlsx-writer.js";

function toCellText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return `${value}`;
  }
  if (value && typeof value === "object") {
    const candidate = value as { text?: unknown };
    if (typeof candidate.text === "string") {
      return candidate.text;
    }
  }
  return "";
}

describe("xlsx-writer", () => {
  it("writes Issues sheet with defaults, styles, and normalized Arabic", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-legal-xlsx-writer-"));
    const outPath = path.join(tmpDir, "issues.xlsx");

    const issues: IssueRecord[] = [
      {
        issueId: "ISS-001",
        article: "1",
        clause: "",
        category: "TERMINOLOGY",
        arabicExcerpt: "ا\u064E\u0644\u0634\u0631\u0643\u0629".normalize("NFD"),
        englishExcerpt: "old",
        correction: "new",
        severity: "HIGH",
        notes: "",
        apply: true,
      },
    ];

    await writeIssuesReport(issues, outPath);
    await fs.access(outPath);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(outPath);
    const sheet = wb.getWorksheet("Issues");
    expect(sheet).toBeTruthy();

    const zip = await JSZip.loadAsync(await fs.readFile(outPath));
    const stylesXml = await zip.file("xl/styles.xml")?.async("string");
    expect(stylesXml).toContain('readingOrder="2"');

    const applyCell = sheet?.getCell("J2");
    expect(toCellText(applyCell?.value)).toBe("Yes");

    const arabicOut = toCellText(sheet?.getCell("F2").value);
    expect(arabicOut).toBe(arabicOut.normalize("NFC"));

    const severityCell = sheet?.getCell("E2");
    expect((severityCell?.fill as { fgColor?: { argb?: string } })?.fgColor?.argb).toBe("FFFF4444");
  });
});
