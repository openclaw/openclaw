import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeEpub } from "./epub.js";
import { validatePublishingExports } from "./export-validation.js";
import { buildPrintHtml } from "./packaging.js";
import type { BookBible, BookOutline } from "./types.js";

async function tempDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-book-writer-export-"));
}

function fixtureBible(): BookBible {
  return {
    runId: "export-test",
    title: "The Export Test",
    subtitle: "An Original Test",
    slug: "the-export-test",
    penName: "Northstar House",
    genre: "clean mystery",
    readerPromise: "A complete original test book.",
    premise: "A test premise.",
    cast: [],
    originalityStrategy: [],
    bannedDependencies: [],
    targetWords: 200,
    createdAt: "2026-05-17T00:00:00.000Z",
  };
}

function fixtureOutline(): BookOutline {
  return {
    runId: "export-test",
    chapters: [{ number: 1, title: "Opening", promise: "Start", beats: [] }],
  };
}

async function writeFixturePackage(dir: string): Promise<{
  epubPath: string;
  printHtmlPath: string;
  printPdfPath: string;
}> {
  const bible = fixtureBible();
  const outline = fixtureOutline();
  const manuscript = "# The Export Test\n\n## Chapter 1: Opening\n\nA clean original chapter.";
  const epubPath = path.join(dir, "ebook.epub");
  const printHtmlPath = path.join(dir, "print.html");
  const printPdfPath = path.join(dir, "print.pdf");
  await writeEpub({ outputPath: epubPath, bible, outline, manuscript });
  await fs.writeFile(printHtmlPath, buildPrintHtml({ bible, outline, manuscript }), "utf8");
  return { epubPath, printHtmlPath, printPdfPath };
}

describe("book-writer export validation", () => {
  it("warns when official EPUBCheck and PDF export tools are unavailable", async () => {
    const dir = await tempDir();
    const paths = await writeFixturePackage(dir);

    const result = await validatePublishingExports({
      ...paths,
      env: {
        PATH: "",
        OPENCLAW_BOOK_WRITER_DISABLE_PDF_EXPORT: "1",
      },
    });

    expect(result.report.status).toBe("warn");
    expect(
      result.report.findings.find((finding) => finding.code === "print-trim-size")?.status,
    ).toBe("pass");
    expect(result.report.findings.find((finding) => finding.code === "print-margin")?.status).toBe(
      "pass",
    );
    expect(result.report.findings.find((finding) => finding.code === "epubcheck")?.status).toBe(
      "warn",
    );
    expect(result.printPdfPath).toBeUndefined();
  });

  it("passes when EPUBCheck and PDF export commands succeed", async () => {
    const dir = await tempDir();
    const binDir = path.join(dir, "bin");
    await fs.mkdir(binDir);
    await fs.writeFile(path.join(binDir, "epubcheck"), "");
    await fs.writeFile(path.join(binDir, "cupsfilter"), "");
    const paths = await writeFixturePackage(dir);

    const result = await validatePublishingExports({
      ...paths,
      env: { PATH: binDir, OPENCLAW_BOOK_WRITER_EXTERNAL_PDF_EXPORT: "1" },
      commandRunner: async (command) => {
        if (command.endsWith("epubcheck")) {
          return { code: 0, stdout: Buffer.from("ok"), stderr: "" };
        }
        if (command.endsWith("cupsfilter")) {
          return { code: 0, stdout: Buffer.from(`%PDF-1.7\n${"x".repeat(2048)}`), stderr: "" };
        }
        return { code: 1, stdout: Buffer.from(""), stderr: "unexpected command" };
      },
    });

    expect(result.report.status).toBe("pass");
    expect(result.report.findings.find((finding) => finding.code === "epubcheck")?.status).toBe(
      "pass",
    );
    expect(
      result.report.findings.find((finding) => finding.code === "print-pdf-export")?.status,
    ).toBe("pass");
    expect(result.printPdfPath).toBe(paths.printPdfPath);
    const pdf = await fs.readFile(paths.printPdfPath);
    expect(pdf.subarray(0, 4).toString("latin1")).toBe("%PDF");
  });
});
