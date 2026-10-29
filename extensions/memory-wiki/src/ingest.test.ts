// Memory Wiki tests cover ingest plugin behavior.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import { describe, expect, it, vi } from "vitest";
import { deferred } from "./deferred.test-helpers.js";
import { ingestMemoryWikiSource } from "./ingest.js";
import { withMemoryWikiVaultMutation } from "./mutation-coordinator.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createTempDir, createVault } = createMemoryWikiTestHarness();

describe("ingestMemoryWikiSource", () => {
  it.skipIf(process.platform === "win32").each(["source", "page"])(
    "refuses a FIFO %s without holding the vault mutation queue",
    async (target) => {
      const rootDir = await createTempDir("memory-wiki-fifo-");
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [
          "--import",
          fileURLToPath(new URL("../../../scripts/tsx.mjs", import.meta.url)),
          fileURLToPath(new URL("./ingest-special-file.test-support.ts", import.meta.url)),
          rootDir,
          target,
        ],
        { timeout: 20_000, killSignal: "SIGKILL" },
      );
      expect(stdout).toContain("FIFO refused; original preserved; vault queue released");
    },
    25_000,
  );

  it.each(["source", "page"])("refuses a directory %s without modifying it", async (target) => {
    const rootDir = await createTempDir("memory-wiki-directory-");
    const inputPath = path.join(rootDir, "notes.txt");
    const { config } = await createVault({
      rootDir: path.join(rootDir, "vault"),
      initialize: true,
    });
    const pagePath = path.join(config.vault.path, "sources", "notes.md");
    await fs.writeFile(inputPath, "source content");
    const directory = target === "source" ? inputPath : pagePath;
    if (target === "source") {
      await fs.unlink(inputPath);
    }
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, "keep"), "handwritten notes");
    await expect(ingestMemoryWikiSource({ config, inputPath })).rejects.toThrow(/regular/);
    await expect(fs.readFile(path.join(directory, "keep"), "utf8")).resolves.toBe(
      "handwritten notes",
    );
  });

  it("preserves symlink-to-regular source and existing-page support", async () => {
    const rootDir = await createTempDir("memory-wiki-symlink-");
    const inputPath = path.join(rootDir, "notes.txt");
    const targetPath = path.join(rootDir, "actual.txt");
    await fs.writeFile(targetPath, "Unicode: café 日本語");
    await fs.symlink(targetPath, inputPath);
    const { config } = await createVault({ rootDir: path.join(rootDir, "vault") });
    await ingestMemoryWikiSource({ config, inputPath });
    const pagePath = path.join(config.vault.path, "sources", "notes.md");
    const savedPagePath = path.join(rootDir, "saved.md");
    const page = (await fs.readFile(pagePath, "utf8")).replace(
      "<!-- openclaw:human:start -->",
      "<!-- openclaw:human:start -->\nHuman note",
    );
    await fs.writeFile(pagePath, page);
    await fs.rename(pagePath, savedPagePath);
    await fs.symlink(savedPagePath, pagePath);
    await ingestMemoryWikiSource({ config, inputPath });
    const after = await fs.readFile(pagePath, "utf8");
    expect(after).toContain("Unicode: café 日本語");
    expect(after).toContain("Human note");
    expect((await fs.lstat(pagePath)).isSymbolicLink()).toBe(true);
  });

  it("recreates an existing page that disappears before its read", async () => {
    const rootDir = await createTempDir("memory-wiki-disappeared-");
    const inputPath = path.join(rootDir, "notes.txt");
    const { config } = await createVault({ rootDir: path.join(rootDir, "vault") });
    await fs.writeFile(inputPath, "original content");
    await ingestMemoryWikiSource({ config, inputPath });
    const pagePath = path.join(config.vault.path, "sources", "notes.md");
    const realpath = fs.realpath.bind(fs);
    let removed = false;
    const spy = vi.spyOn(fs, "realpath").mockImplementation(async (filePath, options) => {
      if (filePath === pagePath && !removed) {
        removed = true;
        await fs.unlink(pagePath);
      }
      return realpath(filePath, options);
    });
    try {
      await fs.writeFile(inputPath, "replacement content");
      await ingestMemoryWikiSource({ config, inputPath });
      expect(removed).toBe(true);
      await expect(fs.readFile(pagePath, "utf8")).resolves.toContain("replacement content");
    } finally {
      spy.mockRestore();
    }
  });

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

  it("ingests a source with many backtick runs without losing its content", async () => {
    const rootDir = await createTempDir("memory-wiki-ingest-backticks-");
    const inputPath = path.join(rootDir, "backticks.txt");
    const content = "`x".repeat(1_000_000) + "\n````\n";
    await fs.writeFile(inputPath, content, "utf8");
    const { config } = await createVault({ rootDir: path.join(rootDir, "vault") });

    const result = await ingestMemoryWikiSource({
      config,
      inputPath,
      nowMs: Date.UTC(2026, 3, 5, 12, 0, 0),
    });

    expect(result).toMatchObject({
      pagePath: "sources/backticks.md",
      bytes: 2_000_006,
      created: true,
    });
    expect(result.indexUpdatedFiles.length).toBeGreaterThan(0);
    const page = await fs.readFile(path.join(config.vault.path, result.pagePath), "utf8");
    expect(page).toContain(
      ["## Content", "`````text", content, "`````", "", "## Notes"].join("\n"),
    );
    await expect(fs.readFile(path.join(config.vault.path, "index.md"), "utf8")).resolves.toContain(
      "[backticks](sources/backticks.md)",
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

    const ingestQueued = deferred();
    const originalEnqueue = Object.getOwnPropertyDescriptor(KeyedAsyncQueue.prototype, "enqueue")
      ?.value as KeyedAsyncQueue["enqueue"];
    const enqueueSpy = vi.spyOn(KeyedAsyncQueue.prototype, "enqueue").mockImplementation(function (
      this: KeyedAsyncQueue,
      key,
      task,
      hooks,
    ) {
      ingestQueued.resolve();
      return originalEnqueue.call(this, key, task, hooks);
    });
    let ingest: ReturnType<typeof ingestMemoryWikiSource> | undefined;
    try {
      ingest = ingestMemoryWikiSource({
        config,
        inputPath,
        nowMs: Date.UTC(2026, 3, 5, 12, 0, 0),
      });
      // On fixed code this observes ingest joining the held queue before any
      // filesystem work. On unfixed code it observes nested compile only after
      // the source page was already written, so the assertion fails.
      await ingestQueued.promise;
      await expect(fs.access(pagePath)).rejects.toThrow();

      releaseLock.resolve();
      // Completion also proves the nested compile re-enters the held vault
      // lock reentrantly instead of deadlocking.
      const result = await ingest;
      await holder;
      expect(result.created).toBe(true);
      await expect(fs.readFile(pagePath, "utf8")).resolves.toContain("hello from source");
    } finally {
      releaseLock.resolve();
      enqueueSpy.mockRestore();
      await Promise.allSettled([holder, ...(ingest ? [ingest] : [])]);
    }
  });
});
