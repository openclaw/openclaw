import fs from "node:fs/promises";
import path from "node:path";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import { describe, expect, it, vi } from "vitest";
import { deferred } from "./deferred.test-helpers.js";
import { ingestMemoryWikiSource } from "./ingest.js";
import { withMemoryWikiVaultMutation } from "./mutation-coordinator.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createTempDir, createVault } = createMemoryWikiTestHarness();
async function sourceFixture(filename: string, content: string) {
  const rootDir = await createTempDir("memory-wiki-ingest-");
  const inputPath = path.join(rootDir, filename);
  const { config } = await createVault({ rootDir: path.join(rootDir, "vault") });
  await fs.writeFile(inputPath, content, "utf8");
  const ingest = () =>
    ingestMemoryWikiSource({ config, inputPath, nowMs: Date.UTC(2026, 3, 5, 12) });
  return { config, inputPath, ingest };
}

describe("ingestMemoryWikiSource", () => {
  it("rejects malformed source encodings without replacing the imported page", async () => {
    const content = "\uFEFFNotes: café, 東京, 🦞\n";
    const { config, inputPath, ingest } = await sourceFixture("notes.txt", content);
    const result = await ingest();
    const pagePath = path.join(config.vault.path, result.pagePath);
    const original = await fs.readFile(pagePath);
    expect(original.toString("utf8")).toContain(content);

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

  it("copies a local text file into sources markdown", async () => {
    const { config, inputPath, ingest } = await sourceFixture(
      "meeting-notes.txt",
      "hello from source\n",
    );
    const result = await ingest();
    expect(result).toMatchObject({
      pageId: "source.meeting-notes",
      pagePath: "sources/meeting-notes.md",
    });
    expect(result.indexUpdatedFiles.length).toBeGreaterThan(0);
    await expect(
      fs.readFile(path.join(config.vault.path, "sources", "meeting-notes.md"), "utf8"),
    ).resolves.toBe(
      [
        `---\npageType: source\nid: source.meeting-notes\ntitle: meeting notes\nsourceType: local-file\nsourcePath: ${inputPath}\ningestedAt: 2026-04-05T12:00:00.000Z\nupdatedAt: 2026-04-05T12:00:00.000Z\nstatus: active\n---`,
        "# meeting notes",
        `## Source\n- Type: \`local-file\`\n- Path: \`${inputPath}\`\n- Bytes: 18\n- Updated: 2026-04-05T12:00:00.000Z`,
        "## Content\n```text\nhello from source\n\n```",
        "## Notes\n<!-- openclaw:human:start -->\n<!-- openclaw:human:end -->",
        "## Related\n<!-- openclaw:wiki:related:start -->\n- No related pages yet.\n<!-- openclaw:wiki:related:end -->\n",
      ].join("\n\n"),
    );
    await expect(fs.readFile(path.join(config.vault.path, "index.md"), "utf8")).resolves.toContain(
      "[meeting notes](sources/meeting-notes.md)",
    );
  });

  it("ingests a source with many backtick runs without losing its content", async () => {
    const content = "`x".repeat(1_000_000) + "\n````\n";
    const { config, ingest } = await sourceFixture("backticks.txt", content);
    const result = await ingest();

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
    const { config, ingest: startIngest } = await sourceFixture(
      "meeting-notes.txt",
      "hello from source\n",
    );
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
      ingest = startIngest();
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
