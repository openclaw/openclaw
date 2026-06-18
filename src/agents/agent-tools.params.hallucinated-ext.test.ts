/** Tests for hallucinated file extension correction in tool params. */
import { describe, it, expect } from "vitest";
import {
  correctHallucinatedFileExtension,
  correctHallucinatedFileExtensionFromKeys,
} from "./agent-tools.params.js";

describe("correctHallucinatedFileExtension", () => {
  it.each([
    ["report.docodex", "report.docx"],
    ["slides.pptcodex", "slides.pptx"],
    ["data.xlscodex", "data.xlsx"],
    ["doc.pdfcodex", "doc.pdf"],
    ["notes.txtcodex", "notes.txt"],
    ["readme.mdcodex", "readme.md"],
    ["config.jsoncodex", "config.json"],
    ["manifest.xmlcodex", "manifest.xml"],
    ["export.csvcodex", "export.csv"],
    ["path/to/file.docodex", "path/to/file.docx"],
    ["deep/nested/path/file.pptcodex", "deep/nested/path/file.pptx"],
    ["FILE.DOCODEX", "FILE.DOCX"],
    ["MixedCase.DoCoDeX", "MixedCase.DoCx"],
  ])("corrects %s to %s", (input, expected) => {
    expect(correctHallucinatedFileExtension(input)).toBe(expected);
  });

  it.each([
    "report.docx",
    "slides.pptx",
    "data.xlsx",
    "document.pdf",
    "notes.txt",
    "readme.md",
    "config.json",
    "data.xml",
    "export.csv",
    "no-extension",
    "README",
  ])("leaves valid extension %s unchanged", (input) => {
    expect(correctHallucinatedFileExtension(input)).toBe(input);
  });

  it("handles empty string", () => {
    expect(correctHallucinatedFileExtension("")).toBe("");
  });

  it("handles path with multiple dots", () => {
    expect(correctHallucinatedFileExtension("archive.tar.docodex")).toBe("archive.tar.docx");
  });
});

describe("correctHallucinatedFileExtensionFromKeys", () => {
  it("corrects extension in specified key", () => {
    const input = { path: "file.docodex", other: "value" };
    const result = correctHallucinatedFileExtensionFromKeys(input, ["path"]);
    expect(result).toEqual({ path: "file.docx", other: "value" });
  });

  it("does not mutate original record", () => {
    const input = { path: "file.docodex" };
    const result = correctHallucinatedFileExtensionFromKeys(input, ["path"]);
    expect(result).not.toBe(input);
    expect(input.path).toBe("file.docodex");
  });

  it("returns same record when no corrections needed", () => {
    const input = { path: "file.docx", other: "value" };
    const result = correctHallucinatedFileExtensionFromKeys(input, ["path"]);
    expect(result).toBe(input);
  });

  it("handles multiple keys", () => {
    const input = { path: "file.docodex", dest: "backup.pptcodex", keep: "original.txt" };
    const result = correctHallucinatedFileExtensionFromKeys(input, ["path", "dest"]);
    expect(result).toEqual({ path: "file.docx", dest: "backup.pptx", keep: "original.txt" });
  });

  it("skips non-string values", () => {
    const input = { path: 123, dest: null, keep: undefined };
    const result = correctHallucinatedFileExtensionFromKeys(input as any, ["path", "dest", "keep"]);
    expect(result).toBe(input);
  });
});
