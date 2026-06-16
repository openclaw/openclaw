/**
 * Tests for hallucinated file extension correction in tool parameters.
 * Catches model-side hallucination patterns where "codex" bleeds into
 * file extensions (e.g. .docx → .docodex) and auto-corrects them.
 */
import { describe, expect, it } from "vitest";
import { correctHallucinatedFileExtension } from "./agent-tools.params.js";

describe("correctHallucinatedFileExtension", () => {
  it("returns .docx unchanged", () => {
    expect(correctHallucinatedFileExtension("report.docx")).toBe("report.docx");
    expect(correctHallucinatedFileExtension("/path/to/file.docx")).toBe("/path/to/file.docx");
  });

  it("returns paths with no extension unchanged", () => {
    expect(correctHallucinatedFileExtension("Makefile")).toBe("Makefile");
    expect(correctHallucinatedFileExtension("/path/to/README")).toBe("/path/to/README");
  });

  it("corrects .docodex → .docx", () => {
    expect(correctHallucinatedFileExtension("report.docodex")).toBe("report.docx");
    expect(correctHallucinatedFileExtension("/path/to/file.docodex")).toBe("/path/to/file.docx");
  });

  it("corrects .docxcodex → .docx", () => {
    expect(correctHallucinatedFileExtension("report.docxcodex")).toBe("report.docx");
  });

  it("corrects .pptcodex → .pptx", () => {
    expect(correctHallucinatedFileExtension("slides.pptcodex")).toBe("slides.pptx");
    expect(correctHallucinatedFileExtension("/path/to/slides.pptcodex")).toBe(
      "/path/to/slides.pptx",
    );
  });

  it("corrects .pptxcodex → .pptx", () => {
    expect(correctHallucinatedFileExtension("slides.pptxcodex")).toBe("slides.pptx");
  });

  it("corrects .xlscodex → .xlsx", () => {
    expect(correctHallucinatedFileExtension("data.xlscodex")).toBe("data.xlsx");
    expect(correctHallucinatedFileExtension("/path/to/data.xlscodex")).toBe("/path/to/data.xlsx");
  });

  it("corrects .xlstcodex → .xlsx", () => {
    expect(correctHallucinatedFileExtension("data.xlstcodex")).toBe("data.xlsx");
  });

  it("corrects .xlstxcodex → .xlsx", () => {
    expect(correctHallucinatedFileExtension("data.xlstxcodex")).toBe("data.xlsx");
  });

  it("leaves unknown extensions unchanged", () => {
    expect(correctHallucinatedFileExtension("file.txt")).toBe("file.txt");
    expect(correctHallucinatedFileExtension("file.py")).toBe("file.py");
    expect(correctHallucinatedFileExtension("file.ts")).toBe("file.ts");
    expect(correctHallucinatedFileExtension("file.pdf")).toBe("file.pdf");
  });

  it("handles empty and non-string input gracefully", () => {
    expect(correctHallucinatedFileExtension("")).toBe("");
    expect(correctHallucinatedFileExtension("  ")).toBe("  ");
  });

  it("preserves directory path components", () => {
    expect(correctHallucinatedFileExtension("/Users/me/Documents/report.docodex")).toBe(
      "/Users/me/Documents/report.docx",
    );
  });

  it("handles case-insensitive extension matching", () => {
    expect(correctHallucinatedFileExtension("report.DOCODEX")).toBe("report.docx");
    expect(correctHallucinatedFileExtension("report.Docodex")).toBe("report.docx");
  });
});
