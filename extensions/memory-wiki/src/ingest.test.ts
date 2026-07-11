// Memory Wiki tests cover ingest plugin behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ingestMemoryWikiSource } from "./ingest.js";
import { withMemoryWikiVaultMutation } from "./mutation-coordinator.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createTempDir, createVault } = createMemoryWikiTestHarness();

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

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

  it("queues behind a held vault mutation instead of writing mid-transaction", async () => {
    const rootDir = await createTempDir("memory-wiki-ingest-lock-");
    const inputPath = path.join(rootDir, "meeting-notes.txt");
    await fs.writeFile(inputPath, "hello from source\n", "utf8");
    const { config } = await createVault({
      rootDir: path.join(rootDir, "vault"),
    });
    const pagePath = path.join(config.vault.path, "sources", "meeting-notes.md");

    const lockEntered = deferred();
    const releaseLock = deferred();
    const holder = withMemoryWikiVaultMutation(config.vault.path, async () => {
      lockEntered.resolve();
      await releaseLock.promise;
    });
    await lockEntered.promise;

    const ingest = ingestMemoryWikiSource({
      config,
      inputPath,
      nowMs: Date.UTC(2026, 3, 5, 12, 0, 0),
    });
    // Give an unserialized ingest enough real turns to reach its page write.
    await new Promise((done) => {
      setTimeout(done, 50);
    });
    await expect(fs.access(pagePath)).rejects.toThrow();

    releaseLock.resolve();
    // Completion also proves the nested compile re-enters the held vault
    // lock reentrantly instead of deadlocking.
    const result = await ingest;
    await holder;
    expect(result.created).toBe(true);
    await expect(fs.readFile(pagePath, "utf8")).resolves.toContain("hello from source");
  });
});
