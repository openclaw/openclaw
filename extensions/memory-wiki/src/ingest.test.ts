import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { deferred } from "./deferred.test-helpers.js";
import { ingestMemoryWikiSource } from "./ingest.js";
import { slugifyWikiPageStem } from "./markdown.js";
import { withMemoryWikiVaultMutation } from "./mutation-coordinator.js";
import { createMemoryWikiTestHarness, observeKeyedQueueEnqueue } from "./test-helpers.js";

const { createTempDir, createVault } = createMemoryWikiTestHarness();
async function sourceFixture(filename = "meeting-notes.txt", content = "hello from source\n") {
  const rootDir = await createTempDir("memory-wiki-ingest-");
  const inputPath = path.join(rootDir, filename);
  const { config } = await createVault({ rootDir: path.join(rootDir, "vault") });
  await fs.writeFile(inputPath, content, "utf8");
  const ingest = (title?: string) =>
    ingestMemoryWikiSource({
      config,
      inputPath,
      ...(title !== undefined ? { title } : {}),
      nowMs: Date.UTC(2026, 3, 5, 12),
    });
  const read = (file: string) => fs.readFile(path.join(config.vault.path, file), "utf8");
  return { config, inputPath, ingest, read };
}

describe("ingestMemoryWikiSource", () => {
  it("preserves the imported page across invalid source files and retry", async () => {
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
      undefined,
    ]) {
      await fs.rm(inputPath, { recursive: true });
      await (bytes ? fs.writeFile(inputPath, bytes) : fs.mkdir(inputPath));
      await expect(ingest()).rejects.toThrow(bytes ? /UTF-8/ : /regular.*file/);
      expect(await fs.readFile(pagePath)).toEqual(original);
      const actual = bytes ? fs.readFile(inputPath) : fs.readdir(inputPath);
      await expect(actual).resolves.toEqual(bytes ?? []);
    }
    await fs.rm(inputPath, { recursive: true });
    await fs.writeFile(inputPath, content, "utf8");
    expect((await ingest()).created).toBe(false);
    expect(await fs.readFile(pagePath, "utf8")).toContain(content);
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

  it.each([
    ["precomposed (NFC)", "café"],
    ["decomposed (NFD)", "cafe\u0301"],
  ] as const)("maps %s titles onto one canonical source page", async (_label, title) => {
    const { config, ingest } = await sourceFixture();
    const result = await ingest(title);
    expect(result).toMatchObject({ pagePath: "sources/café.md", pageId: "source.café" });
    const sources = await fs.readdir(path.join(config.vault.path, "sources"));
    expect(sources.filter((name) => name.endsWith(".md") && name !== "index.md")).toEqual([
      "café.md",
    ]);
  });

  it("reuses a released decomposed page instead of creating a duplicate", async () => {
    const { config, ingest } = await sourceFixture();
    const nfd = "cafe\u0301";
    const publishedPath = path.join(config.vault.path, "sources", `${nfd}.md`);
    await fs.mkdir(path.dirname(publishedPath), { recursive: true });
    await fs.writeFile(
      publishedPath,
      [
        "---",
        "pageType: source",
        `id: source.${nfd}`,
        `title: ${nfd}`,
        "sourceType: local-file",
        "---",
        "",
        `# ${nfd}`,
        "",
        "## Notes",
        "<!-- openclaw:human:start -->",
        "HANDWRITTEN NOTE MUST SURVIVE",
        "<!-- openclaw:human:end -->",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await ingest("café");
    expect(result).toMatchObject({
      pagePath: `sources/${nfd}.md`,
      pageId: `source.${nfd}`,
      created: false,
    });
    expect(await fs.readFile(publishedPath, "utf8")).toContain("HANDWRITTEN NOTE MUST SURVIVE");
    const sources = await fs.readdir(path.join(config.vault.path, "sources"));
    expect(sources.filter((name) => name.endsWith(".md") && name !== "index.md")).toEqual([
      `${nfd}.md`,
    ]);
  });

  it("reuses a released mixed-form page (café-naïve) when re-ingested in any normalization", async () => {
    const { config, ingest } = await sourceFixture();
    // Released page slug is a *mixed* normalization: café composed (NFC) but
    // naïve decomposed (NFD). The resolver must reuse it on re-ingest regardless
    // of which normalization the new title arrives in.
    const mixed = "café-nai\u0308ve";
    const publishedPath = path.join(config.vault.path, "sources", `${mixed}.md`);
    await fs.mkdir(path.dirname(publishedPath), { recursive: true });
    await fs.writeFile(
      publishedPath,
      [
        "---",
        "pageType: source",
        `id: source.${mixed}`,
        `title: ${mixed}`,
        "sourceType: local-file",
        "---",
        "",
        `# ${mixed}`,
        "",
        "## Notes",
        "<!-- openclaw:human:start -->",
        "MIXED NOTE MUST SURVIVE",
        "<!-- openclaw:human:end -->",
        "",
      ].join("\n"),
      "utf8",
    );

    // Re-ingest the same visual title in canonical (NFC) form.
    const result = await ingest("Café naïve".normalize("NFC"));
    expect(result).toMatchObject({
      pagePath: `sources/${mixed}.md`,
      pageId: `source.${mixed}`,
      created: false,
    });
    expect(await fs.readFile(publishedPath, "utf8")).toContain("MIXED NOTE MUST SURVIVE");
    const sources = await fs.readdir(path.join(config.vault.path, "sources"));
    expect(sources.filter((name) => name.endsWith(".md") && name !== "index.md")).toEqual([
      `${mixed}.md`,
    ]);
  });

  it("reuses a released hash-truncated NFD page when re-ingested in NFC form", async () => {
    const { config, ingest } = await sourceFixture();
    // A long title (100 decomposed é) exceeds the 240-byte slug cap, so slugify
    // truncates it and appends a content hash. A *released* page built from the
    // NFD spelling therefore stores that hash-truncated stem; re-ingesting the
    // same visual title in canonical (NFC) form must reuse it, not create a
    // duplicate page with a new ID and no Notes.
    const longNfd = "cafe\u0301".repeat(100);
    const longNfc = longNfd.normalize("NFC");
    const releasedStem = slugifyWikiPageStem(longNfd);
    expect(releasedStem).toMatch(/-[0-9a-f]{12}$/);
    const publishedPath = path.join(config.vault.path, "sources", `${releasedStem}.md`);
    await fs.mkdir(path.dirname(publishedPath), { recursive: true });
    await fs.writeFile(
      publishedPath,
      [
        "---",
        "pageType: source",
        `id: source.${releasedStem}`,
        `title: ${longNfd}`,
        "sourceType: local-file",
        "---",
        "",
        `# ${longNfd}`,
        "",
        "## Notes",
        "<!-- openclaw:human:start -->",
        "HASH TRUNCATED NOTE MUST SURVIVE",
        "<!-- openclaw:human:end -->",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await ingest(longNfc);
    expect(result).toMatchObject({
      pagePath: `sources/${releasedStem}.md`,
      pageId: `source.${releasedStem}`,
      created: false,
    });
    expect(await fs.readFile(publishedPath, "utf8")).toContain("HASH TRUNCATED NOTE MUST SURVIVE");
    const sources = await fs.readdir(path.join(config.vault.path, "sources"));
    const mdFiles = sources.filter((name) => name.endsWith(".md") && name !== "index.md");
    expect(mdFiles).toEqual([`${releasedStem}.md`]);
  });

  it("reuses a released long mixed-form page when the title arrives in uppercase NFC", async () => {
    const { config, ingest } = await sourceFixture();
    // Longer than the 240-byte slug cap *and* mixed-form (composed é, decomposed
    // ï), so the released stem is a hash-truncated string that equals neither the
    // NFC nor the NFD candidate. Matching must go through the stored title and
    // compare canonical slugs, or a case variant creates a second page.
    const releasedTitle = "café-nai\u0308ve-".repeat(40);
    const releasedStem = slugifyWikiPageStem(releasedTitle);
    expect(releasedStem).toMatch(/-[0-9a-f]{12}$/);
    expect(releasedStem).not.toBe(slugifyWikiPageStem(releasedTitle.normalize("NFC")));
    const publishedPath = path.join(config.vault.path, "sources", `${releasedStem}.md`);
    await fs.mkdir(path.dirname(publishedPath), { recursive: true });
    await fs.writeFile(
      publishedPath,
      [
        "---",
        "pageType: source",
        `id: source.${releasedStem}`,
        `title: ${releasedTitle}`,
        "sourceType: local-file",
        "---",
        "",
        `# ${releasedTitle}`,
        "",
        "## Notes",
        "<!-- openclaw:human:start -->",
        "MIXED HASH NOTE MUST SURVIVE",
        "<!-- openclaw:human:end -->",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await ingest(releasedTitle.normalize("NFC").toUpperCase());
    expect(result).toMatchObject({
      pagePath: `sources/${releasedStem}.md`,
      pageId: `source.${releasedStem}`,
      created: false,
    });
    expect(await fs.readFile(publishedPath, "utf8")).toContain("MIXED HASH NOTE MUST SURVIVE");
    const sources = await fs.readdir(path.join(config.vault.path, "sources"));
    expect(sources.filter((name) => name.endsWith(".md") && name !== "index.md")).toEqual([
      `${releasedStem}.md`,
    ]);
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
