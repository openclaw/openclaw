// Memory Wiki tests cover ingest plugin behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ingestMemoryWikiSource } from "./ingest.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createTempDir, createVault } = createMemoryWikiTestHarness();

describe("ingestMemoryWikiSource", () => {
  it("copies a local text file into sources markdown", async () => {
    const rootDir = await createTempDir("memory-wiki-ingest-");
    const inputPath = path.join(rootDir, "meeting-notes.txt");
    await fs.writeFile(inputPath, "hello from source\n", "utf8");
    const { config } = await createVault({
      rootDir: path.join(rootDir, "vault"),
    });

    const result = await ingestMemoryWikiSource({
      config,
      inputPath,
      nowMs: Date.UTC(2026, 3, 5, 12, 0, 0),
    });

    expect(result.pageId).toBe("source.meeting-notes");
    expect(result.pagePath).toBe("sources/meeting-notes.md");
    expect(result.indexUpdatedFiles.length).toBeGreaterThan(0);
    await expect(fs.readFile(path.join(config.vault.path, "sources", "meeting-notes.md"), "utf8"))
      .resolves.toBe(`---
pageType: source
id: source.meeting-notes
title: meeting notes
sourceType: local-file
sourcePath: ${inputPath}
ingestedAt: 2026-04-05T12:00:00.000Z
updatedAt: 2026-04-05T12:00:00.000Z
status: active
---

# meeting notes

## Source
- Type: \`local-file\`
- Path: \`${inputPath}\`
- Bytes: 18
- Updated: 2026-04-05T12:00:00.000Z

## Content
\`\`\`text
hello from source

\`\`\`

## Notes
<!-- openclaw:human:start -->
<!-- openclaw:human:end -->

## Related
<!-- openclaw:wiki:related:start -->
- No related pages yet.
<!-- openclaw:wiki:related:end -->
`);
    await expect(fs.readFile(path.join(config.vault.path, "index.md"), "utf8")).resolves.toContain(
      "[meeting notes](sources/meeting-notes.md)",
    );
  });

  it("propagates read errors instead of silently wiping human notes (regression for #98345)", async () => {
    const rootDir = await createTempDir("memory-wiki-ingest-proof-");
    const inputPath = path.join(rootDir, "notes.md");
    await fs.writeFile(inputPath, "v1 content\n", "utf8");
    const { config } = await createVault({
      rootDir: path.join(rootDir, "vault"),
    });

    // First ingest — creates the source page
    await ingestMemoryWikiSource({ config, inputPath, nowMs: 0 });
    const pagePath = path.join(config.vault.path, "sources", "notes.md");

    // Add human notes to simulate user edits
    const pageContent = await fs.readFile(pagePath, "utf8");
    const withNotes = pageContent.replace(
      "<!-- openclaw:human:end -->",
      "user note that should survive\n<!-- openclaw:human:end -->",
    );
    await fs.writeFile(pagePath, withNotes, "utf8");

    // Update source to trigger re-ingest
    await fs.writeFile(inputPath, "v2 content\n", "utf8");

    // Inject a one-shot readFile failure on the existing-page re-read (EIO)
    const originalReadFile = fs.readFile;
    let injected = false;
    const failingReadFile = ((p: string, opts?: unknown) => {
      if (!injected && String(p).includes("notes.md")) {
        injected = true;
        const err = new Error("EIO: i/o error") as NodeJS.ErrnoException;
        err.code = "EIO";
        return Promise.reject(err);
      }
      return originalReadFile(p as string, opts as never);
    }) as typeof fs.readFile;
    (fs as { readFile: typeof fs.readFile }).readFile = failingReadFile;

    try {
      // Re-ingest should THROW (not silently wipe notes)
      await ingestMemoryWikiSource({ config, inputPath, nowMs: 1 });
      // If we get here, the error was swallowed — BUG
      expect(true).toBe(false);
    } catch (err) {
      // Expected: read error propagated
      expect(String(err)).toContain("EIO");
    } finally {
      (fs as { readFile: typeof fs.readFile }).readFile = originalReadFile;
    }

    // After failed ingest, notes must survive
    const afterPage = await fs.readFile(pagePath, "utf8");
    expect(afterPage).toContain("user note that should survive");
  });
});
