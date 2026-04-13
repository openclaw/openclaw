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

    expect(result.pageId).toMatch(/^source\.meeting-notes-[a-f0-9]{8}$/);
    expect(result.pagePath).toMatch(/^sources\/meeting-notes-[a-f0-9]{8}\.md$/);
    expect(result.indexUpdatedFiles.length).toBeGreaterThan(0);
    await expect(
      fs.readFile(path.join(config.vault.path, result.pagePath), "utf8"),
    ).resolves.toContain("hello from source");
    await expect(fs.readFile(path.join(config.vault.path, "index.md"), "utf8")).resolves.toContain(
      `[meeting notes](${result.pagePath})`,
    );
  });

  it("reuses an existing legacy source page identity when reingesting an old vault", async () => {
    const rootDir = await createTempDir("memory-wiki-ingest-legacy-");
    const actualDir = path.join(rootDir, "actual");
    const aliasDir = path.join(rootDir, "alias");
    await fs.mkdir(actualDir, { recursive: true });
    await fs.mkdir(aliasDir, { recursive: true });
    const actualPath = path.join(actualDir, "meeting-notes.txt");
    const aliasPath = path.join(aliasDir, "meeting-notes.txt");
    await fs.writeFile(actualPath, "updated source content\n", "utf8");
    await fs.symlink(actualPath, aliasPath);
    const { config } = await createVault({
      rootDir: path.join(rootDir, "vault"),
    });
    const legacyPagePath = path.join(config.vault.path, "sources", "meeting-notes.md");
    await fs.mkdir(path.dirname(legacyPagePath), { recursive: true });
    await fs.writeFile(
      legacyPagePath,
      [
        "---",
        "pageType: source",
        "id: source.meeting-notes",
        "title: meeting notes",
        "sourceType: local-file",
        `sourcePath: ${aliasPath}`,
        "status: active",
        "---",
        "",
        "# meeting notes",
        "",
        "legacy source body",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await ingestMemoryWikiSource({
      config,
      inputPath: actualPath,
      nowMs: Date.UTC(2026, 3, 5, 12, 0, 0),
    });

    expect(result.pageId).toBe("source.meeting-notes");
    expect(result.pagePath).toBe("sources/meeting-notes.md");
    expect(result.created).toBe(false);
    await expect(fs.readFile(legacyPagePath, "utf8")).resolves.toContain("updated source content");
  });

  it("keeps pure CJK source titles on distinct pages", async () => {
    const rootDir = await createTempDir("memory-wiki-ingest-cjk-");
    const firstInputPath = path.join(rootDir, "cjk-a.txt");
    const secondInputPath = path.join(rootDir, "cjk-b.txt");
    await fs.writeFile(firstInputPath, "first cjk source\n", "utf8");
    await fs.writeFile(secondInputPath, "second cjk source\n", "utf8");
    const { config } = await createVault({
      rootDir: path.join(rootDir, "vault"),
    });

    const first = await ingestMemoryWikiSource({
      config,
      inputPath: firstInputPath,
      title: "大语言模型概述",
      nowMs: Date.UTC(2026, 3, 5, 12, 0, 0),
    });
    const second = await ingestMemoryWikiSource({
      config,
      inputPath: secondInputPath,
      title: "大语言模型导论",
      nowMs: Date.UTC(2026, 3, 5, 12, 0, 0),
    });

    expect(first.pageId).not.toBe(second.pageId);
    expect(first.pagePath).not.toBe(second.pagePath);
    await expect(
      fs.readFile(path.join(config.vault.path, first.pagePath), "utf8"),
    ).resolves.toContain("first cjk source");
    await expect(
      fs.readFile(path.join(config.vault.path, second.pagePath), "utf8"),
    ).resolves.toContain("second cjk source");
  });

  it("keeps similar titles with the same slug on separate pages", async () => {
    const rootDir = await createTempDir("memory-wiki-ingest-slug-");
    const firstInputPath = path.join(rootDir, "slug-a.txt");
    const secondInputPath = path.join(rootDir, "slug-b.txt");
    await fs.writeFile(firstInputPath, "first slug source\n", "utf8");
    await fs.writeFile(secondInputPath, "second slug source\n", "utf8");
    const { config } = await createVault({
      rootDir: path.join(rootDir, "vault"),
    });

    const first = await ingestMemoryWikiSource({
      config,
      inputPath: firstInputPath,
      title: "hello world",
      nowMs: Date.UTC(2026, 3, 5, 12, 0, 0),
    });
    const second = await ingestMemoryWikiSource({
      config,
      inputPath: secondInputPath,
      title: "hello-world",
      nowMs: Date.UTC(2026, 3, 5, 12, 0, 0),
    });

    expect(first.pageId).not.toBe(second.pageId);
    expect(first.pagePath).not.toBe(second.pagePath);
    await expect(
      fs.readFile(path.join(config.vault.path, first.pagePath), "utf8"),
    ).resolves.toContain("first slug source");
    await expect(
      fs.readFile(path.join(config.vault.path, second.pagePath), "utf8"),
    ).resolves.toContain("second slug source");
  });

  it("keeps repeated ingest of the same source stable", async () => {
    const rootDir = await createTempDir("memory-wiki-ingest-repeat-");
    const inputPath = path.join(rootDir, "repeat.txt");
    await fs.writeFile(inputPath, "repeat source\n", "utf8");
    const { config } = await createVault({
      rootDir: path.join(rootDir, "vault"),
    });

    const first = await ingestMemoryWikiSource({
      config,
      inputPath,
      title: "Repeated Source",
      nowMs: Date.UTC(2026, 3, 5, 12, 0, 0),
    });
    const second = await ingestMemoryWikiSource({
      config,
      inputPath,
      title: "Repeated Source",
      nowMs: Date.UTC(2026, 3, 5, 12, 0, 0),
    });

    expect(second.created).toBe(false);
    expect(second.pageId).toBe(first.pageId);
    expect(second.pagePath).toBe(first.pagePath);
    await expect(
      fs.readFile(path.join(config.vault.path, first.pagePath), "utf8"),
    ).resolves.toContain("repeat source");
  });

  it("keeps plain ASCII titles readable and stable", async () => {
    const rootDir = await createTempDir("memory-wiki-ingest-ascii-");
    const inputPath = path.join(rootDir, "ascii.txt");
    await fs.writeFile(inputPath, "ascii source\n", "utf8");
    const { config } = await createVault({
      rootDir: path.join(rootDir, "vault"),
    });

    const first = await ingestMemoryWikiSource({
      config,
      inputPath,
      title: "Hello World",
      nowMs: Date.UTC(2026, 3, 5, 12, 0, 0),
    });
    const second = await ingestMemoryWikiSource({
      config,
      inputPath,
      title: "Hello World",
      nowMs: Date.UTC(2026, 3, 5, 12, 0, 0),
    });

    expect(first.pageId).toMatch(/^source\.hello-world-[a-f0-9]{8}$/);
    expect(first.pagePath).toMatch(/^sources\/hello-world-[a-f0-9]{8}\.md$/);
    expect(second.pageId).toBe(first.pageId);
    expect(second.pagePath).toBe(first.pagePath);
  });

  it("keeps the same title on different source paths separate", async () => {
    const rootDir = await createTempDir("memory-wiki-ingest-same-title-");
    const firstInputPath = path.join(rootDir, "one.txt");
    const secondInputPath = path.join(rootDir, "two.txt");
    await fs.writeFile(firstInputPath, "same title source one\n", "utf8");
    await fs.writeFile(secondInputPath, "same title source two\n", "utf8");
    const { config } = await createVault({
      rootDir: path.join(rootDir, "vault"),
    });

    const first = await ingestMemoryWikiSource({
      config,
      inputPath: firstInputPath,
      title: "Shared Title",
      nowMs: Date.UTC(2026, 3, 5, 12, 0, 0),
    });
    const second = await ingestMemoryWikiSource({
      config,
      inputPath: secondInputPath,
      title: "Shared Title",
      nowMs: Date.UTC(2026, 3, 5, 12, 0, 0),
    });

    expect(first.pageId).not.toBe(second.pageId);
    expect(first.pagePath).not.toBe(second.pagePath);
    await expect(
      fs.readFile(path.join(config.vault.path, first.pagePath), "utf8"),
    ).resolves.toContain("same title source one");
    await expect(
      fs.readFile(path.join(config.vault.path, second.pagePath), "utf8"),
    ).resolves.toContain("same title source two");
  });

  it("treats symlinked paths to the same file as one stable source", async () => {
    const rootDir = await createTempDir("memory-wiki-ingest-symlink-");
    const actualDir = path.join(rootDir, "actual");
    const aliasDir = path.join(rootDir, "alias");
    await fs.mkdir(actualDir, { recursive: true });
    await fs.mkdir(aliasDir, { recursive: true });
    const actualPath = path.join(actualDir, "shared.txt");
    const aliasPath = path.join(aliasDir, "shared-link.txt");
    await fs.writeFile(actualPath, "shared source content\n", "utf8");
    await fs.symlink(actualPath, aliasPath);
    const { config } = await createVault({
      rootDir: path.join(rootDir, "vault"),
    });

    const first = await ingestMemoryWikiSource({
      config,
      inputPath: actualPath,
      title: "Shared Source",
      nowMs: Date.UTC(2026, 3, 5, 12, 0, 0),
    });
    const second = await ingestMemoryWikiSource({
      config,
      inputPath: aliasPath,
      title: "Shared Source",
      nowMs: Date.UTC(2026, 3, 5, 12, 0, 0),
    });

    expect(first.pageId).toBe(second.pageId);
    expect(first.pagePath).toBe(second.pagePath);
    expect(second.created).toBe(false);
    expect(second.sourcePath).toBe(actualPath);
  });
});
