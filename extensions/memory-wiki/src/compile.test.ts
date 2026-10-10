// Memory Wiki tests cover compile plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { compileMemoryWikiVault, refreshMemoryWikiIndexesAfterImport } from "./compile.js";
import { loadMemoryWikiCompiledCache, readMemoryWikiDashboardState } from "./compiled-cache.js";
import { renderWikiMarkdown } from "./markdown.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

function writePage(targetPath: string, markdown: Parameters<typeof renderWikiMarkdown>[0]) {
  return fs.writeFile(targetPath, renderWikiMarkdown(markdown), "utf8");
}

const { createVault } = createMemoryWikiTestHarness();

describe("compileMemoryWikiVault", () => {
  let suiteRoot = "";
  let caseId = 0;

  beforeAll(async () => {
    suiteRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-wiki-compile-suite-"));
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  afterAll(async () => {
    if (suiteRoot) {
      await fs.rm(suiteRoot, { recursive: true, force: true });
    }
  });

  function nextCaseRoot() {
    return path.join(suiteRoot, `case-${caseId++}`);
  }

  function expectDigestPage<T extends { path: string }>(pages: T[], pagePath: string): T {
    const page = pages.find((candidate) => candidate.path === pagePath);
    if (!page) {
      throw new Error(`Expected digest page ${pagePath}`);
    }
    return page;
  }

  async function expectCompiledCache(config: Parameters<typeof compileMemoryWikiVault>[0]) {
    const snapshot = await loadMemoryWikiCompiledCache(config);
    if (!snapshot) {
      throw new Error(`Expected compiled cache for ${config.vault.path}`);
    }
    return snapshot;
  }

  it("keeps changed imports compile-required when auto-compile is disabled", async () => {
    const { rootDir, config } = await createVault({
      rootDir: nextCaseRoot(),
      config: {
        ingest: { autoCompile: false },
        render: { createBacklinks: false, createDashboards: false },
      },
      initialize: true,
    });
    const sourcePath = path.join(rootDir, "sources", "cache-only.md");
    const renderSource = (value: string) =>
      renderWikiMarkdown({
        frontmatter: {
          pageType: "source",
          sourceType: "chatgpt-export",
          title: "Cache only",
        },
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
    const { rootDir, config } = await createVault({
      rootDir: nextCaseRoot(),
      initialize: true,
      config: { render: { createDashboards: false } },
    });
    const sourcePath = path.join(rootDir, "sources", "preserved.md");
    const source = renderWikiMarkdown({
      frontmatter: {
        pageType: "source",
        id: "source.preserved",
        title: "Preserved",
      },
      body: "# Preserved\n",
    });
    await fs.writeFile(sourcePath, source, "utf8");

    const preserved = await compileMemoryWikiVault(config, {
      sourcePageWrites: "preserve",
    });

    await expect(fs.readFile(sourcePath, "utf8")).resolves.toBe(source);
    await expect(fs.readFile(path.join(rootDir, "index.md"), "utf8")).resolves.toContain(
      "[Preserved](sources/preserved.md)",
    );
    expect(preserved.updatedFiles).not.toContain(sourcePath);
    expect((await expectCompiledCache(config)).digest.pages.map((page) => page.path)).toContain(
      "sources/preserved.md",
    );

    const normal = await compileMemoryWikiVault(config);
    expect(normal.updatedFiles).toContain(sourcePath);
    await expect(fs.readFile(sourcePath, "utf8")).resolves.toContain(
      "<!-- openclaw:wiki:related:start -->",
    );
  });

  it.each([
    {
      name: "directory index with syntax-error frontmatter",
      relativePath: "sources/index.md",
      frontmatterLines: [
        "pageType: report",
        "sourceIds:",
        '  - **MEMORY.md line 235**:"some quoted, value"',
      ],
      error: "Unexpected scalar",
    },
  ])(
    "rejects $name without changing its bytes",
    async ({ relativePath, frontmatterLines, error }) => {
      const { rootDir, config } = await createVault({
        rootDir: nextCaseRoot(),
        initialize: true,
        config: { render: { createDashboards: false } },
      });
      const targetPath = path.join(rootDir, relativePath);
      const original = [
        "---",
        ...frontmatterLines,
        "---",
        "",
        "# Existing Index",
        "",
        "Keep this body.",
      ].join("\n");
      await fs.writeFile(targetPath, original, "utf8");

      await expect(compileMemoryWikiVault(config)).rejects.toThrow(error);
      await expect(fs.readFile(targetPath, "utf8")).resolves.toBe(original);
    },
  );

  it("bounds concurrent page reads and stops the queue after abort", async () => {
    const { rootDir, config } = await createVault({
      rootDir: nextCaseRoot(),
      initialize: true,
    });

    for (let index = 0; index < 24; index += 1) {
      await writePage(path.join(rootDir, "sources", `page-${index}.md`), {
        frontmatter: {
          pageType: "source",
          id: `source.page-${index}`,
          title: `Page ${index}`,
        },
        body: `# Page ${index}\n`,
      });
    }

    const originalReadFile = fs.readFile.bind(fs);
    const abortController = new AbortController();
    let pageReads = 0;
    let activePageReads = 0;
    let maxActivePageReads = 0;
    const readFileSpy = vi
      .spyOn(fs, "readFile")
      .mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
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

    try {
      await expect(
        compileMemoryWikiVault(config, { signal: abortController.signal }),
      ).rejects.toThrow();
    } finally {
      readFileSpy.mockRestore();
    }

    expect(pageReads).toBe(16);
    expect(maxActivePageReads).toBeLessThanOrEqual(16);
  });

  it("does not rewrite empty source pages into related-only stubs", async () => {
    const { rootDir, config } = await createVault({
      rootDir: nextCaseRoot(),
      initialize: true,
    });
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
    const { rootDir, config } = await createVault({
      rootDir: nextCaseRoot(),
      initialize: true,
    });

    await writePage(path.join(rootDir, "sources", "alpha.md"), {
      frontmatter: { pageType: "source", id: "source.alpha", title: "Alpha" },
      body: "# Alpha\n",
    });

    for (let index = 0; index < 30; index += 1) {
      await writePage(path.join(rootDir, "entities", `entity-${index}.md`), {
        frontmatter: {
          pageType: "entity",
          id: `entity.${index}`,
          title: `Entity ${index}`,
          sourceIds: ["source.alpha"],
        },
        body: `# Entity ${index}\n`,
      });
    }

    await compileMemoryWikiVault(config);

    const firstEntity = await fs.readFile(path.join(rootDir, "entities", "entity-0.md"), "utf8");
    const sourcePage = await fs.readFile(path.join(rootDir, "sources", "alpha.md"), "utf8");
    expect(firstEntity).toContain("[Alpha](../sources/alpha.md)");
    expect(firstEntity).not.toContain("### Related Pages");
    expect(sourcePage).not.toContain("### Referenced By");
  });

  it("writes agent directory, relationship, provenance, and privacy reports", async () => {
    const { rootDir, config } = await createVault({
      rootDir: nextCaseRoot(),
      initialize: true,
    });

    await writePage(path.join(rootDir, "entities", "brad.md"), {
      frontmatter: {
        pageType: "entity",
        entityType: "person",
        id: "entity.brad",
        title: "Brad Groux",
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
      body: "# Brad Groux\n",
    });

    await compileMemoryWikiVault(config);

    await expect(
      fs.readFile(path.join(rootDir, "reports", "person-agent-directory.md"), "utf8"),
    ).resolves.toContain("[Brad Groux](../entities/brad.md)");
    await expect(
      fs.readFile(path.join(rootDir, "reports", "relationship-graph.md"), "utf8"),
    ).resolves.toContain("[Brad Groux](../entities/brad.md) -> Alice");
    await expect(
      fs.readFile(path.join(rootDir, "reports", "provenance-coverage.md"), "utf8"),
    ).resolves.toContain("maintainer-whois: 1");
    await expect(
      fs.readFile(path.join(rootDir, "reports", "privacy-review.md"), "utf8"),
    ).resolves.toContain("[Brad Groux](../entities/brad.md)");

    const { digest: agentDigest, claims } = await expectCompiledCache(config);
    const bradPage = expectDigestPage(agentDigest.pages, "entities/brad.md");
    expect(bradPage.canonicalId).toBe("maintainer.brad-groux");
    expect(bradPage.aliases).toEqual(["brad"]);
    expect(bradPage.personCard?.lane).toBe("Microsoft Teams");
    expect(bradPage.relationshipCount).toBe(1);
    expect(claims.flatMap((claim) => claim.evidenceKinds ?? [])).toContain("maintainer-whois");
  });
  it("refuses to rewrite a page that is not valid UTF-8 and leaves it unchanged", async () => {
    const { rootDir, config } = await createVault({
      rootDir: nextCaseRoot(),
      initialize: true,
    });
    const entityDir = path.join(rootDir, "entities");
    await fs.mkdir(entityDir, { recursive: true });
    const entityPath = path.join(entityDir, "router.md");
    const malformed = Buffer.concat([
      Buffer.from(
        "---\npageType: entity\nid: entity.router\ntitle: Router\nstatus: active\n---\n# Router\n\n## Human Notes\n\nlatin1: caf",
        "utf8",
      ),
      Buffer.from([0xff]),
      Buffer.from(" keeps dropping\n", "utf8"),
    ]);
    await fs.writeFile(entityPath, malformed);

    await expect(compileMemoryWikiVault(config)).rejects.toMatchObject({
      name: "WikiPageNotUtf8Error",
    });
    // The rewrite never happened: the undecodable byte survived untouched.
    expect(await fs.readFile(entityPath)).toEqual(malformed);
  });

  it("compiles valid non-ASCII pages including a literal replacement character", async () => {
    const { rootDir, config } = await createVault({
      rootDir: nextCaseRoot(),
      initialize: true,
    });
    const entityDir = path.join(rootDir, "entities");
    await fs.mkdir(entityDir, { recursive: true });
    const entityPath = path.join(entityDir, "router.md");
    const notesLine = "- 中文 🦀 \uFFFD tail";
    await writePage(entityPath, {
      frontmatter: {
        pageType: "entity",
        id: "entity.router",
        title: "Router",
      },
      body: `# Router\n\n## Human Notes\n\n${notesLine}\n`,
    });

    await compileMemoryWikiVault(config);

    const after = await fs.readFile(entityPath, "utf8");
    expect(after).toContain(notesLine);
    expect(after).toContain("<!-- openclaw:wiki:related:start -->");
  });
});
