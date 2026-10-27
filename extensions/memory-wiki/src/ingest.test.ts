import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { deferred } from "./deferred.test-helpers.js";
import { ingestMemoryWikiSource } from "./ingest.js";
import { withMemoryWikiVaultMutation } from "./mutation-coordinator.js";
import { createMemoryWikiTestHarness, observeKeyedQueueEnqueue } from "./test-helpers.js";

const { createTempDir, createVault } = createMemoryWikiTestHarness();
async function sourceFixture(filename = "meeting-notes.txt", content = "hello from source\n") {
  const rootDir = await createTempDir("memory-wiki-ingest-");
  const inputPath = path.join(rootDir, filename);
  const { config } = await createVault({ rootDir: path.join(rootDir, "vault") });
  await fs.writeFile(inputPath, content, "utf8");
  const ingest = () =>
    ingestMemoryWikiSource({ config, inputPath, nowMs: Date.UTC(2026, 3, 5, 12) });
  const read = (relativePath: string) =>
    fs.readFile(path.join(config.vault.path, relativePath), "utf8");
  return { config, inputPath, ingest, read };
}

describe("ingestMemoryWikiSource", () => {
  it("rejects malformed source encodings without replacing the imported page", async () => {
    const content = "\uFEFFNotes: café, 東京, 🦞\n";
    const { config, inputPath, ingest, read } = await sourceFixture("meeting-notes.txt", content);
    const result = await ingest();
    expect(result).toMatchObject({
      pageId: "source.meeting-notes",
      pagePath: "sources/meeting-notes.md",
    });
    expect(result.indexUpdatedFiles.length).toBeGreaterThan(0);
    const pagePath = path.join(config.vault.path, result.pagePath);
    const original = await fs.readFile(pagePath);
    expect(original.toString("utf8")).toContain(content);
    expect(original.toString("utf8")).toContain(`## Content\n\`\`\`text\n${content}\n\`\`\``);
    expect(original.toString("utf8")).toContain(`- Bytes: ${Buffer.byteLength(content)}`);
    expect(original.toString("utf8")).toContain(
      `---\npageType: source\nid: source.meeting-notes\ntitle: meeting notes\nsourceType: local-file\nsourcePath: ${inputPath}\ningestedAt: 2026-04-05T12:00:00.000Z\nupdatedAt: 2026-04-05T12:00:00.000Z\nstatus: active\n---`,
    );
    await expect(read("index.md")).resolves.toContain("[meeting notes](sources/meeting-notes.md)");

    for (const bytes of [
      Buffer.from([0xff, 0x41]),
      Buffer.from([0xe2, 0x82]),
      Buffer.from([0xed, 0xa0, 0x80]),
      Buffer.concat([Buffer.from("valid UTF-8 café then Latin-1: "), Buffer.from([0xe9])]),
    ]) {
      await fs.writeFile(inputPath, bytes);
      await expect(ingest()).rejects.toThrow(/UTF-8/);
      expect(await fs.readFile(pagePath)).toEqual(original);
      expect(await fs.readFile(inputPath)).toEqual(bytes);
    }
  });

  it("ingests a source with many backtick runs without losing its content", async () => {
    const content = "`x".repeat(1_000_000) + "\n````\n";
    const { ingest, read } = await sourceFixture("backticks.txt", content);
    const result = await ingest();
    expect(result).toMatchObject({
      pagePath: "sources/backticks.md",
      bytes: 2_000_006,
      created: true,
    });
    expect(result.indexUpdatedFiles.length).toBeGreaterThan(0);
    const page = await read(result.pagePath);
    expect(page).toContain(
      ["## Content", "`````text", content, "`````", "", "## Notes"].join("\n"),
    );
    await expect(read("index.md")).resolves.toContain("[backticks](sources/backticks.md)");
  });

  it("queues behind a held vault mutation instead of writing mid-transaction", async () => {
    const { config, ingest: startIngest } = await sourceFixture();
    const pagePath = path.join(config.vault.path, "sources", "meeting-notes.md");
    const lockEntered = deferred();
    const releaseLock = deferred();
    const holder = withMemoryWikiVaultMutation(config.vault.path, async () => {
      lockEntered.resolve();
      await releaseLock.promise;
    });
    await lockEntered.promise;
    const ingestQueued = deferred();
    const enqueueSpy = observeKeyedQueueEnqueue(() => ingestQueued.resolve());
    let ingest: ReturnType<typeof ingestMemoryWikiSource> | undefined;
    try {
      ingest = startIngest();
      // Pre-fix, only nested compile queued, after the source page was already written.
      await ingestQueued.promise;
      await expect(fs.access(pagePath)).rejects.toThrow();

      releaseLock.resolve();
      // Completion proves nested compile re-enters instead of deadlocking.
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
