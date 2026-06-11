import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeEpub } from "./epub.js";
import { validateEpubStructure } from "./quality.js";
import type { BookBible, BookOutline } from "./types.js";

describe("book-writer EPUB packaging", () => {
  it("writes required EPUB entries", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-book-writer-epub-"));
    const outputPath = path.join(dir, "ebook.epub");
    const bible: BookBible = {
      runId: "run",
      title: "The Test Book",
      subtitle: "An Original Test",
      slug: "the-test-book",
      penName: "Northstar House",
      genre: "clean mystery",
      readerPromise: "A complete original test book.",
      premise: "A test premise.",
      cast: [],
      originalityStrategy: [],
      bannedDependencies: [],
      targetWords: 200,
      createdAt: "2026-05-14T00:00:00.000Z",
    };
    const outline: BookOutline = {
      runId: "run",
      chapters: [{ number: 1, title: "Opening", promise: "Start", beats: [] }],
    };

    await writeEpub({
      outputPath,
      bible,
      outline,
      manuscript: "# The Test Book\n\n## Chapter 1: Opening\n\nA clean original chapter.",
    });

    const report = await validateEpubStructure(outputPath);
    expect(report.status).toBe("pass");
    const buffer = await fs.readFile(outputPath);
    expect(buffer.subarray(0, 2).toString("latin1")).toBe("PK");
    expect(buffer.toString("latin1")).toContain(
      '<meta property="dcterms:modified">2026-05-14T00:00:00Z</meta>',
    );
  });
});
