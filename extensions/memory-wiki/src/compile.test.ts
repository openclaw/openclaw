import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compileMemoryWikiVault, refreshMemoryWikiIndexesAfterImport } from "./compile.js";
import { loadMemoryWikiCompiledCache, readMemoryWikiDashboardState } from "./compiled-cache.js";
import type { MemoryWikiPluginConfig } from "./config.js";
import { renderWikiMarkdown } from "./markdown.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

function writePage(
  targetPath: string,
  id: string,
  title: string,
  options: { frontmatter?: Record<string, unknown>; body?: string } = {},
) {
  const markdown = {
    frontmatter: { pageType: id.split(".")[0], id, title, ...options.frontmatter },
    body: options.body ?? `# ${title}\n`,
  };
  return fs.writeFile(targetPath, renderWikiMarkdown(markdown), "utf8");
}

const { createVault: createTestVault } = createMemoryWikiTestHarness();
const createVault = (config?: MemoryWikiPluginConfig) =>
  createTestVault({ initialize: true, config });

describe("compileMemoryWikiVault", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps changed imports compile-required when auto-compile is disabled", async () => {
    const { rootDir, config } = await createVault({
      ingest: { autoCompile: false },
      render: { createBacklinks: false, createDashboards: false },
    });
    const sourcePath = path.join(rootDir, "sources", "cache-only.md");
    const renderSource = (value: string) =>
      renderWikiMarkdown({
        frontmatter: { pageType: "source", sourceType: "chatgpt-export", title: "Cache only" },
        body: `# Cache only\n\n## Auto Digest\n- First user line: ${value}\n`,
      });
    await fs.writeFile(sourcePath, renderSource("before"), "utf8");
    await compileMemoryWikiVault(config);
    const snapshotBefore = await loadMemoryWikiCompiledCache(config);
    const indexBefore = await fs.readFile(path.join(rootDir, "index.md"), "utf8");

    await fs.writeFile(sourcePath, renderSource("after"), "utf8");
    const refresh = await refreshMemoryWikiIndexesAfterImport({
      config,
      syncResult: { importedCount: 0, updatedCount: 1, removedCount: 0 },
    });
    const snapshotAfter = await loadMemoryWikiCompiledCache(config);

    expect(refresh).toMatchObject({ refreshed: false, reason: "auto-compile-disabled" });
    expect(JSON.stringify(snapshotBefore?.dashboards)).toContain("before");
    expect(snapshotAfter).toEqual(snapshotBefore);
    expect(JSON.stringify(snapshotAfter?.dashboards)).not.toContain("after");
    await expect(readMemoryWikiDashboardState(config)).resolves.toEqual({
      state: "compile-required",
    });
    await expect(fs.readFile(path.join(rootDir, "index.md"), "utf8")).resolves.toBe(indexBefore);
  });

  it("preserves source page bytes while rebuilding derived artifacts", async () => {
    const { rootDir, config } = await createVault({ render: { createDashboards: false } });
    const sourcePath = path.join(rootDir, "sources", "preserved.md");
    const source = renderWikiMarkdown({
      frontmatter: { pageType: "source", id: "source.preserved", title: "Preserved" },
      body: "# Preserved\n",
    });
    await fs.writeFile(sourcePath, source, "utf8");

    const preserved = await compileMemoryWikiVault(config, { sourcePageWrites: "preserve" });

    await expect(fs.readFile(sourcePath, "utf8")).resolves.toBe(source);
    await expect(fs.readFile(path.join(rootDir, "index.md"), "utf8")).resolves.toContain(
      "[Preserved](sources/preserved.md)",
    );
    expect(preserved.updatedFiles).not.toContain(sourcePath);
    expect(
      expectDefined(await loadMemoryWikiCompiledCache(config), "compiled cache").digest.pages.map(
        (page) => page.path,
      ),
    ).toContain("sources/preserved.md");

    const normal = await compileMemoryWikiVault(config);
    expect(normal.updatedFiles).toContain(sourcePath);
    await expect(fs.readFile(sourcePath, "utf8")).resolves.toContain(
      "<!-- openclaw:wiki:related:start -->",
    );
  });

  it("rejects directory-index syntax-error frontmatter without changing its bytes", async () => {
    const { rootDir, config } = await createVault({ render: { createDashboards: false } });
    const targetPath = path.join(rootDir, "sources/index.md");
    const original =
      '---\npageType: report\nsourceIds:\n  - **MEMORY.md line 235**:"some quoted, value"\n---\n\n# Existing Index\n\nKeep this body.';
    await fs.writeFile(targetPath, original, "utf8");
    await expect(compileMemoryWikiVault(config)).rejects.toThrow("Unexpected scalar");
    await expect(fs.readFile(targetPath, "utf8")).resolves.toBe(original);
  });

  it("bounds concurrent page reads and stops the queue after abort", async () => {
    const { rootDir, config } = await createVault();

    for (let index = 0; index < 24; index += 1) {
      await writePage(
        path.join(rootDir, "sources", `page-${index}.md`),
        `source.page-${index}`,
        `Page ${index}`,
      );
    }

    const originalReadFile = fs.readFile.bind(fs);
    const abortController = new AbortController();
    let pageReads = 0;
    let activePageReads = 0;
    let maxActivePageReads = 0;
    vi.spyOn(fs, "readFile").mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
      const targetPath = args[0];
      const isTestPageRead =
        typeof targetPath === "string" &&
        targetPath.startsWith(path.join(rootDir, "sources", "page-"));
      if (!isTestPageRead) {
        return await originalReadFile(...args);
      }

      activePageReads += 1;
      pageReads += 1;
      maxActivePageReads = Math.max(maxActivePageReads, activePageReads);
      if (pageReads === 16) {
        abortController.abort();
      }
      try {
        await Promise.resolve();
        return await originalReadFile(...args);
      } finally {
        activePageReads -= 1;
      }
    });

    await expect(
      compileMemoryWikiVault(config, { signal: abortController.signal }),
    ).rejects.toThrow();

    expect(pageReads).toBe(16);
    expect(maxActivePageReads).toBeLessThanOrEqual(16);
  });

  it("rejects publication when a source changes after its compiled bytes were read", async () => {
    const { rootDir, config } = await createVault({
      render: { createBacklinks: false, createDashboards: false },
    });
    const sourcePath = path.join(rootDir, "sources", "edited.md");
    await fs.writeFile(sourcePath, "# Before\n", "utf8");
    const readFile = fs.readFile.bind(fs);
    let edited = false;
    vi.spyOn(fs, "readFile").mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
      const value = await readFile(...args);
      if (args[0] === sourcePath && !edited) {
        edited = true;
        await fs.writeFile(sourcePath, "# After\n", "utf8");
      }
      return value;
    });

    await expect(compileMemoryWikiVault(config)).rejects.toThrow(
      "vault changed while its compiled cache was being published",
    );
    await expect(loadMemoryWikiCompiledCache(config)).resolves.toBeNull();
    await expect(readMemoryWikiDashboardState(config)).resolves.toEqual({ state: "failed" });
    await expect(fs.readFile(sourcePath, "utf8")).resolves.toBe("# After\n");
  });

  it("does not rewrite empty source pages into related-only stubs", async () => {
    const { rootDir, config } = await createVault();
    const emptySourcePath = path.join(rootDir, "sources", "empty.md");
    const whitespaceSourcePath = path.join(rootDir, "sources", "whitespace.md");
    await fs.writeFile(emptySourcePath, "", "utf8");
    await fs.writeFile(whitespaceSourcePath, " \n\t", "utf8");

    const result = await compileMemoryWikiVault(config);

    await expect(fs.readFile(emptySourcePath, "utf8")).resolves.toBe("");
    await expect(fs.readFile(whitespaceSourcePath, "utf8")).resolves.toBe(" \n\t");
    expect(result.updatedFiles).not.toContain(emptySourcePath);
    expect(result.updatedFiles).not.toContain(whitespaceSourcePath);
  });

  it("does not relate every page through a broad shared source", async () => {
    const { rootDir, config } = await createVault();

    await writePage(path.join(rootDir, "sources", "alpha.md"), "source.alpha", "Alpha");

    for (let index = 0; index < 30; index += 1) {
      await writePage(
        path.join(rootDir, "entities", `entity-${index}.md`),
        `entity.${index}`,
        `Entity ${index}`,
        {
          frontmatter: { sourceIds: ["source.alpha"] },
        },
      );
    }

    await compileMemoryWikiVault(config);

    const firstEntity = await fs.readFile(path.join(rootDir, "entities", "entity-0.md"), "utf8");
    const sourcePage = await fs.readFile(path.join(rootDir, "sources", "alpha.md"), "utf8");
    expect(firstEntity).toContain("[Alpha](../sources/alpha.md)");
    expect(firstEntity).not.toContain("### Related Pages");
    expect(sourcePage).not.toContain("### Referenced By");
  });

  it("records backlinks from shortest-path, heading, and block wikilinks", async () => {
    const { rootDir, config } = await createVault({ vault: { renderMode: "obsidian" } });

    await writePage(
      path.join(rootDir, "entities", "brad-groux.md"),
      "entity.brad-groux",
      "Brad Groux",
    );
    for (const [slug, title, text] of [
      ["teams-rollout", "Teams Rollout", "Owned by [[brad-groux]]."],
      ["release-train", "Release Train", "See [[entities/brad-groux#Responsibilities|Brad]]."],
      ["block-reference", "Block Reference", "See [[brad-groux#^block]]."],
    ] as const) {
      await writePage(path.join(rootDir, "concepts", `${slug}.md`), `concept.${slug}`, title, {
        body: `# ${title}\n\n${text}\n`,
      });
    }

    await compileMemoryWikiVault(config);

    const brad = await fs.readFile(path.join(rootDir, "entities", "brad-groux.md"), "utf8");
    expect(brad).toContain("### Referenced By");
    expect(brad).toContain("- [[concepts/block-reference|Block Reference]]");
    expect(brad).toContain("- [[concepts/release-train|Release Train]]");
    expect(brad).toContain("- [[concepts/teams-rollout|Teams Rollout]]");
  });

  it("writes agent directory, relationship, provenance, and privacy reports", async () => {
    const { rootDir, config } = await createVault();

    await writePage(path.join(rootDir, "entities", "brad.md"), "entity.brad", "Brad Groux", {
      frontmatter: {
        entityType: "person",
        canonicalId: "maintainer.brad-groux",
        aliases: ["brad"],
        privacyTier: "local-private",
        bestUsedFor: ["Microsoft routing"],
        lastRefreshedAt: "2026-04-29T00:00:00.000Z",
        personCard: {
          handles: ["@bgroux"],
          lane: "Microsoft Teams",
          askFor: ["Teams and Azure questions"],
          privacyTier: "confirm-before-use",
        },
        relationships: [
          {
            targetId: "entity.alice",
            targetTitle: "Alice",
            kind: "collaborates-with",
            evidenceKind: "discrawl-stat",
            privacyTier: "local-private",
          },
        ],
        claims: [
          {
            id: "claim.brad.teams",
            text: "Brad is useful for Microsoft Teams routing.",
            status: "supported",
            confidence: 0.9,
            evidence: [
              {
                kind: "maintainer-whois",
                sourceId: "source.maintainers",
                privacyTier: "local-private",
              },
            ],
          },
        ],
      },
    });

    await compileMemoryWikiVault(config);

    const expectReport = async (name: string, content: string) =>
      expect(fs.readFile(path.join(rootDir, "reports", `${name}.md`), "utf8")).resolves.toContain(
        content,
      );
    await expectReport("person-agent-directory", "[Brad Groux](../entities/brad.md)");
    await expectReport("relationship-graph", "[Brad Groux](../entities/brad.md) -> Alice");
    await expectReport("provenance-coverage", "maintainer-whois: 1");
    await expectReport("privacy-review", "[Brad Groux](../entities/brad.md)");

    const { digest: agentDigest, claims } = expectDefined(
      await loadMemoryWikiCompiledCache(config),
      "compiled cache",
    );
    const bradPage = expectDefined(
      agentDigest.pages.find((page) => page.path === "entities/brad.md"),
      "Brad digest page",
    );
    expect(bradPage).toMatchObject({
      canonicalId: "maintainer.brad-groux",
      aliases: ["brad"],
      personCard: { lane: "Microsoft Teams" },
      relationshipCount: 1,
    });
    expect(claims.flatMap((claim) => claim.evidenceKinds ?? [])).toContain("maintainer-whois");
  });
  it.each(["entities/router.md", "index.md", "reports/open-questions.md"])(
    "refuses to rewrite malformed UTF-8 in %s and leaves it unchanged",
    async (relativePath) => {
      const { rootDir, config } = await createVault();
      const pagePath = path.join(rootDir, relativePath);
      await fs.mkdir(path.dirname(pagePath), { recursive: true });
      const malformed = Buffer.concat([
        Buffer.from(
          "---\npageType: entity\nid: entity.router\ntitle: Router\nstatus: active\n---\n# Router\n\n## Human Notes\n\nlatin1: caf",
          "utf8",
        ),
        Buffer.from([0xff]),
        Buffer.from(" keeps dropping\n", "utf8"),
      ]);
      await fs.writeFile(pagePath, malformed);

      await expect(compileMemoryWikiVault(config)).rejects.toMatchObject({
        name: "WikiPageNotUtf8Error",
        message: expect.stringContaining(relativePath),
      });
      // The rewrite never happened: the undecodable byte survived untouched.
      expect(await fs.readFile(pagePath)).toEqual(malformed);
    },
  );

  it("compiles valid non-ASCII pages including a literal replacement character", async () => {
    const { rootDir, config } = await createVault();
    const entityPath = path.join(rootDir, "entities", "router.md");
    const notesLine = "- 中文 🦀 \uFFFD tail";
    await writePage(entityPath, "entity.router", "Router", {
      body: `# Router\n\n## Human Notes\n\n${notesLine}\n`,
    });

    await compileMemoryWikiVault(config);

    const after = await fs.readFile(entityPath, "utf8");
    expect(after).toContain(notesLine);
    expect(after).toContain("<!-- openclaw:wiki:related:start -->");
  });
});
