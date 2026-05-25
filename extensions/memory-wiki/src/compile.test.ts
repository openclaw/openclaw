import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileMemoryWikiVault, refreshMemoryWikiIndexesAfterImport } from "./compile.js";
import { renderWikiMarkdown } from "./markdown.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createVault } = createMemoryWikiTestHarness();

async function sha256File(filePath: string): Promise<string> {
  return createHash("sha256")
    .update(await fs.readFile(filePath))
    .digest("hex");
}

describe("compileMemoryWikiVault", () => {
  let suiteRoot = "";
  let caseId = 0;

  beforeAll(async () => {
    suiteRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-wiki-compile-suite-"));
  });

  afterAll(async () => {
    if (suiteRoot) {
      await fs.rm(suiteRoot, { recursive: true, force: true });
    }
  });

  function nextCaseRoot() {
    return path.join(suiteRoot, `case-${caseId++}`);
  }

  async function expectPathMissing(targetPath: string): Promise<void> {
    let error: unknown;
    try {
      await fs.access(targetPath);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
  }

  function expectDigestPage<T extends { path: string }>(pages: T[], pagePath: string): T {
    const page = pages.find((candidate) => candidate.path === pagePath);
    if (!page) {
      throw new Error(`Expected digest page ${pagePath}`);
    }
    return page;
  }

  function expectDigestCluster<T extends { key: string }>(clusters: T[], key: string): T {
    const cluster = clusters.find((candidate) => candidate.key === key);
    if (!cluster) {
      throw new Error(`Expected digest contradiction cluster ${key}`);
    }
    return cluster;
  }

  it("writes root and directory indexes for native markdown", async () => {
    const { rootDir, config } = await createVault({
      rootDir: nextCaseRoot(),
      initialize: true,
    });

    await fs.writeFile(
      path.join(rootDir, "sources", "alpha.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "source",
          id: "source.alpha",
          title: "Alpha",
          claims: [
            {
              id: "claim.alpha.doc",
              text: "Alpha is the canonical source page.",
              status: "supported",
              evidence: [{ sourceId: "source.alpha", lines: "1-3" }],
            },
          ],
        },
        body: "# Alpha\n",
      }),
      "utf8",
    );

    const result = await compileMemoryWikiVault(config);

    expect(result.pageCounts.source).toBe(1);
    expect(result.claimCount).toBe(1);
    await expect(fs.readFile(path.join(rootDir, "index.md"), "utf8")).resolves.toContain(
      "[Alpha](sources/alpha.md)",
    );
    await expect(fs.readFile(path.join(rootDir, "index.md"), "utf8")).resolves.toContain(
      "- Claims: 1",
    );
    await expect(fs.readFile(path.join(rootDir, "sources", "index.md"), "utf8")).resolves.toContain(
      "[Alpha](sources/alpha.md)",
    );
    const agentDigest = JSON.parse(
      await fs.readFile(path.join(rootDir, ".openclaw-wiki", "cache", "agent-digest.json"), "utf8"),
    ) as {
      claimCount: number;
      pages: Array<{ path: string; claimCount: number; topClaims: Array<{ text: string }> }>;
    };
    expect(agentDigest.claimCount).toBe(1);
    const alphaPage = expectDigestPage(agentDigest.pages, "sources/alpha.md");
    expect(alphaPage.claimCount).toBe(1);
    expect(alphaPage.topClaims.map((claim) => claim.text)).toEqual([
      "Alpha is the canonical source page.",
    ]);
    const claimsDigestPath = path.join(rootDir, ".openclaw-wiki", "cache", "claims.jsonl");
    await expect(fs.readFile(claimsDigestPath, "utf8")).resolves.toContain(
      '"statement":"Alpha is the canonical source page."',
    );

    const agentDigestPath = path.join(rootDir, ".openclaw-wiki", "cache", "agent-digest.json");
    const manifestPath = path.join(rootDir, ".openclaw-wiki", "cache", "wiki-cache-manifest.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
      claim_extraction: { claim_count: number; missing_statement_count: number };
      compile: {
        page_count: number;
        page_counts: { source: number };
        managed_cache_file_count: number;
      };
      hashes: { agent_digest_sha256: string; claims_jsonl_sha256: string };
      outputs: { agent_digest: { path: string }; claims_jsonl: { path: string } };
    };
    expect(result.manifestPath).toBe(manifestPath);
    expect(manifest.claim_extraction).toMatchObject({
      claim_count: 1,
      missing_statement_count: 0,
    });
    expect(manifest.compile).toMatchObject({
      page_count: result.pages.length,
      page_counts: expect.objectContaining({ source: 1 }),
      managed_cache_file_count: 2,
    });
    expect(manifest.hashes.agent_digest_sha256).toBe(await sha256File(agentDigestPath));
    expect(manifest.hashes.claims_jsonl_sha256).toBe(await sha256File(claimsDigestPath));
    expect(manifest.outputs.agent_digest.path).toBe(".openclaw-wiki/cache/agent-digest.json");
    expect(manifest.outputs.claims_jsonl.path).toBe(".openclaw-wiki/cache/claims.jsonl");
  });

  it("writes reconciled claim supersession metadata to the claims digest", async () => {
    const { rootDir, config } = await createVault({
      rootDir: nextCaseRoot(),
      initialize: true,
    });

    await fs.writeFile(
      path.join(rootDir, "sources", "candidate.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "source",
          id: "source.candidate",
          title: "Candidate",
          sourceType: "operator",
          claims: [
            {
              id: "claim.old",
              claimKey: "repo.openclaw.candidate.active",
              text: "Candidate A is active.",
              authorityTier: 1,
              assertedAt: "2026-05-01T00:00:00.000Z",
            },
            {
              id: "claim.new",
              claimKey: "repo.openclaw.candidate.active",
              text: "Candidate B is active.",
              authorityTier: 3,
              assertedAt: "2026-05-21T00:00:00.000Z",
            },
          ],
        },
        body: "# Candidate\n",
      }),
      "utf8",
    );

    await compileMemoryWikiVault(config);

    const claimsDigestPath = path.join(rootDir, ".openclaw-wiki", "cache", "claims.jsonl");
    const claims = (await fs.readFile(claimsDigestPath, "utf8"))
      .trim()
      .split(/\r?\n/)
      .map(
        (line) =>
          JSON.parse(line) as {
            claim_id: string;
            status: string;
            supersedes: string[];
            superseded_by: string[];
          },
      );
    const oldClaim = claims.find((claim) => claim.claim_id === "claim.old");
    const newClaim = claims.find((claim) => claim.claim_id === "claim.new");
    expect(oldClaim).toMatchObject({
      status: "superseded",
      superseded_by: ["claim.new"],
    });
    expect(newClaim).toMatchObject({
      status: "current",
      supersedes: ["claim.old"],
    });
  });

  it("keeps fallback claim ids stable when sorted claim rank changes", async () => {
    const { rootDir, config } = await createVault({
      rootDir: nextCaseRoot(),
      initialize: true,
    });
    const pagePath = path.join(rootDir, "sources", "ranked.md");

    async function writeRankedPage(alphaConfidence: number, betaConfidence: number) {
      await fs.writeFile(
        pagePath,
        renderWikiMarkdown({
          frontmatter: {
            pageType: "source",
            id: "source.ranked",
            title: "Ranked",
            claims: [
              {
                text: "Alpha fallback identity must stay stable.",
                confidence: alphaConfidence,
              },
              {
                text: "Beta fallback identity must stay stable.",
                confidence: betaConfidence,
              },
            ],
          },
          body: "# Ranked\n",
        }),
        "utf8",
      );
    }

    async function claimIdsByStatement() {
      const claimsDigestPath = path.join(rootDir, ".openclaw-wiki", "cache", "claims.jsonl");
      return new Map(
        (await fs.readFile(claimsDigestPath, "utf8"))
          .trim()
          .split(/\r?\n/)
          .map((line) => JSON.parse(line) as { claim_id: string; statement: string })
          .map((claim) => [claim.statement, claim.claim_id] as const),
      );
    }

    await writeRankedPage(0.1, 0.9);
    await compileMemoryWikiVault(config);
    const before = await claimIdsByStatement();

    await writeRankedPage(0.9, 0.1);
    await compileMemoryWikiVault(config);
    const after = await claimIdsByStatement();

    expect(after.get("Alpha fallback identity must stay stable.")).toBe(
      before.get("Alpha fallback identity must stay stable."),
    );
    expect(after.get("Beta fallback identity must stay stable.")).toBe(
      before.get("Beta fallback identity must stay stable."),
    );
  });

  it("keeps fallback claim ids stable when an earlier id-less claim is inserted", async () => {
    const { rootDir, config } = await createVault({
      rootDir: nextCaseRoot(),
      initialize: true,
    });
    const pagePath = path.join(rootDir, "sources", "inserted.md");

    async function writeClaims(claims: Array<{ text: string }>) {
      await fs.writeFile(
        pagePath,
        renderWikiMarkdown({
          frontmatter: {
            pageType: "source",
            id: "source.inserted",
            title: "Inserted",
            claims,
          },
          body: "# Inserted\n",
        }),
        "utf8",
      );
    }

    async function claimIdsByStatement() {
      const claimsDigestPath = path.join(rootDir, ".openclaw-wiki", "cache", "claims.jsonl");
      return new Map(
        (await fs.readFile(claimsDigestPath, "utf8"))
          .trim()
          .split(/\r?\n/)
          .map((line) => JSON.parse(line) as { claim_id: string; statement: string })
          .map((claim) => [claim.statement, claim.claim_id] as const),
      );
    }

    await writeClaims([
      { text: "Alpha fallback identity survives insertion." },
      { text: "Beta fallback identity survives insertion." },
    ]);
    await compileMemoryWikiVault(config);
    const before = await claimIdsByStatement();

    await writeClaims([
      { text: "New earlier fallback claim." },
      { text: "Alpha fallback identity survives insertion." },
      { text: "Beta fallback identity survives insertion." },
    ]);
    await compileMemoryWikiVault(config);
    const after = await claimIdsByStatement();

    expect(after.get("Alpha fallback identity survives insertion.")).toBe(
      before.get("Alpha fallback identity survives insertion."),
    );
    expect(after.get("Beta fallback identity survives insertion.")).toBe(
      before.get("Beta fallback identity survives insertion."),
    );
  });

  it("disambiguates identical id-less fallback claim rows", async () => {
    const { rootDir, config } = await createVault({
      rootDir: nextCaseRoot(),
      initialize: true,
    });

    await fs.writeFile(
      path.join(rootDir, "sources", "fallback-duplicates.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "source",
          id: "source.fallback-duplicates",
          title: "Fallback Duplicates",
          claims: [
            { text: "Duplicate fallback text needs two rows." },
            { text: "Duplicate fallback text needs two rows." },
          ],
        },
        body: "# Fallback Duplicates\n",
      }),
      "utf8",
    );

    await compileMemoryWikiVault(config);

    const claimsDigestPath = path.join(rootDir, ".openclaw-wiki", "cache", "claims.jsonl");
    const duplicateRows = (await fs.readFile(claimsDigestPath, "utf8"))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { claim_id: string; statement: string })
      .filter((claim) => claim.statement === "Duplicate fallback text needs two rows.");

    expect(duplicateRows).toHaveLength(2);
    expect(new Set(duplicateRows.map((claim) => claim.claim_id)).size).toBe(2);
  });

  it("preserves duplicate explicit claim ids as distinct digest rows", async () => {
    const { rootDir, config } = await createVault({
      rootDir: nextCaseRoot(),
      initialize: true,
    });

    await fs.writeFile(
      path.join(rootDir, "sources", "duplicates.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "source",
          id: "source.duplicates",
          title: "Duplicates",
          claims: [
            {
              id: "claim.duplicate",
              text: "The first duplicate claim.",
            },
            {
              id: "claim.duplicate",
              text: "The second duplicate claim.",
            },
          ],
        },
        body: "# Duplicates\n",
      }),
      "utf8",
    );

    await compileMemoryWikiVault(config);

    const claimsDigestPath = path.join(rootDir, ".openclaw-wiki", "cache", "claims.jsonl");
    const duplicateRows = (await fs.readFile(claimsDigestPath, "utf8"))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { claim_id: string; statement: string })
      .filter((claim) => claim.claim_id === "claim.duplicate");

    expect(duplicateRows.map((claim) => claim.statement)).toEqual([
      "The first duplicate claim.",
      "The second duplicate claim.",
    ]);
  });

  it("writes source-import provenance into the cache manifest", async () => {
    const { rootDir, config } = await createVault({
      rootDir: nextCaseRoot(),
      initialize: true,
    });

    await fs.writeFile(
      path.join(rootDir, "sources", "alpha.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "source",
          id: "source.alpha",
          title: "Alpha",
          claims: [
            {
              id: "claim.alpha",
              text: "Alpha provenance is tracked.",
            },
          ],
        },
        body: "# Alpha\n",
      }),
      "utf8",
    );

    await compileMemoryWikiVault(config, {
      sourceImport: {
        operation: "compile",
        importedCount: 2,
        updatedCount: 1,
        skippedCount: 3,
        removedCount: 4,
        artifactCount: 5,
        workspaces: 6,
        pagePaths: ["sources/alpha.md"],
        indexesRefreshed: true,
        indexRefreshReason: "import-changed",
      },
    });

    const manifest = JSON.parse(
      await fs.readFile(
        path.join(rootDir, ".openclaw-wiki", "cache", "wiki-cache-manifest.json"),
        "utf8",
      ),
    ) as { source_import: Record<string, unknown> };

    expect(manifest.source_import).toMatchObject({
      operation: "compile",
      imported_count: 2,
      updated_count: 1,
      skipped_count: 3,
      removed_count: 4,
      artifact_count: 5,
      workspace_count: 6,
      page_path_count: 1,
      indexes_refreshed: true,
      index_refresh_reason: "import-changed",
    });
  });

  it("writes source-import provenance into auto-refresh manifests", async () => {
    const { rootDir, config } = await createVault({
      rootDir: nextCaseRoot(),
      initialize: true,
    });

    await fs.writeFile(
      path.join(rootDir, "sources", "refresh-provenance.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "source",
          id: "source.refresh-provenance",
          title: "Refresh Provenance",
          claims: [
            {
              id: "claim.refresh-provenance",
              text: "Auto refresh provenance is tracked.",
            },
          ],
        },
        body: "# Refresh Provenance\n",
      }),
      "utf8",
    );

    const result = await refreshMemoryWikiIndexesAfterImport({
      config,
      syncResult: {
        importedCount: 7,
        updatedCount: 6,
        skippedCount: 5,
        removedCount: 4,
        artifactCount: 3,
        workspaces: 2,
        pagePaths: ["sources/refresh-provenance.md"],
      },
    });

    expect(result).toMatchObject({
      refreshed: true,
      reason: "import-changed",
    });

    const manifest = JSON.parse(
      await fs.readFile(
        path.join(rootDir, ".openclaw-wiki", "cache", "wiki-cache-manifest.json"),
        "utf8",
      ),
    ) as { source_import: Record<string, unknown> };

    expect(manifest.source_import).toMatchObject({
      operation: "refresh",
      imported_count: 7,
      updated_count: 6,
      skipped_count: 5,
      removed_count: 4,
      artifact_count: 3,
      workspace_count: 2,
      page_path_count: 1,
      indexes_refreshed: true,
      index_refresh_reason: "import-changed",
    });
  });

  it("touches unchanged cache artifacts when requested", async () => {
    const { rootDir, config } = await createVault({
      rootDir: nextCaseRoot(),
      initialize: true,
    });

    await fs.writeFile(
      path.join(rootDir, "sources", "alpha.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "source",
          id: "source.alpha",
          title: "Alpha",
          claims: [
            {
              id: "claim.alpha.doc",
              text: "Alpha is the canonical source page.",
              status: "supported",
              evidence: [{ sourceId: "source.alpha", lines: "1-3" }],
            },
          ],
        },
        body: "# Alpha\n",
      }),
      "utf8",
    );

    await compileMemoryWikiVault(config);

    const agentDigestPath = path.join(rootDir, ".openclaw-wiki", "cache", "agent-digest.json");
    const claimsDigestPath = path.join(rootDir, ".openclaw-wiki", "cache", "claims.jsonl");
    const stale = new Date("2000-01-01T00:00:00.000Z");
    await fs.utimes(agentDigestPath, stale, stale);
    await fs.utimes(claimsDigestPath, stale, stale);

    const result = await compileMemoryWikiVault(config, { touchCacheArtifacts: true });

    expect(result.updatedFiles).toEqual(
      expect.arrayContaining([agentDigestPath, claimsDigestPath]),
    );
    await expect(fs.stat(agentDigestPath)).resolves.toMatchObject({ size: expect.any(Number) });
    await expect(fs.stat(claimsDigestPath)).resolves.toMatchObject({ size: expect.any(Number) });
    expect((await fs.stat(agentDigestPath)).mtimeMs).toBeGreaterThan(stale.getTime());
    expect((await fs.stat(claimsDigestPath)).mtimeMs).toBeGreaterThan(stale.getTime());
  });

  it("renders obsidian-friendly links when configured", async () => {
    const { rootDir, config } = await createVault({
      rootDir: nextCaseRoot(),
      initialize: true,
      config: {
        vault: { renderMode: "obsidian" },
      },
    });

    await fs.writeFile(
      path.join(rootDir, "sources", "alpha.md"),
      renderWikiMarkdown({
        frontmatter: { pageType: "source", id: "source.alpha", title: "Alpha" },
        body: "# Alpha\n",
      }),
      "utf8",
    );

    await compileMemoryWikiVault(config);

    await expect(fs.readFile(path.join(rootDir, "index.md"), "utf8")).resolves.toContain(
      "[[sources/alpha|Alpha]]",
    );
  });

  it("writes related blocks from source ids and shared sources", async () => {
    const { rootDir, config } = await createVault({
      rootDir: nextCaseRoot(),
      initialize: true,
    });

    await fs.writeFile(
      path.join(rootDir, "sources", "alpha.md"),
      renderWikiMarkdown({
        frontmatter: { pageType: "source", id: "source.alpha", title: "Alpha" },
        body: "# Alpha\n",
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(rootDir, "entities", "beta.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "entity",
          id: "entity.beta",
          title: "Beta",
          sourceIds: ["source.alpha"],
        },
        body: "# Beta\n",
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(rootDir, "concepts", "gamma.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "concept",
          id: "concept.gamma",
          title: "Gamma",
          sourceIds: ["source.alpha"],
        },
        body: "# Gamma\n",
      }),
      "utf8",
    );

    await compileMemoryWikiVault(config);

    await expect(fs.readFile(path.join(rootDir, "entities", "beta.md"), "utf8")).resolves.toContain(
      "## Related",
    );
    await expect(fs.readFile(path.join(rootDir, "entities", "beta.md"), "utf8")).resolves.toContain(
      "[Alpha](sources/alpha.md)",
    );
    await expect(fs.readFile(path.join(rootDir, "entities", "beta.md"), "utf8")).resolves.toContain(
      "[Gamma](concepts/gamma.md)",
    );
    await expect(fs.readFile(path.join(rootDir, "sources", "alpha.md"), "utf8")).resolves.toContain(
      "[Beta](entities/beta.md)",
    );
    await expect(fs.readFile(path.join(rootDir, "sources", "alpha.md"), "utf8")).resolves.toContain(
      "[Gamma](concepts/gamma.md)",
    );
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

    await fs.writeFile(
      path.join(rootDir, "sources", "alpha.md"),
      renderWikiMarkdown({
        frontmatter: { pageType: "source", id: "source.alpha", title: "Alpha" },
        body: "# Alpha\n",
      }),
      "utf8",
    );

    for (let index = 0; index < 30; index += 1) {
      await fs.writeFile(
        path.join(rootDir, "entities", `entity-${index}.md`),
        renderWikiMarkdown({
          frontmatter: {
            pageType: "entity",
            id: `entity.${index}`,
            title: `Entity ${index}`,
            sourceIds: ["source.alpha"],
          },
          body: `# Entity ${index}\n`,
        }),
        "utf8",
      );
    }

    await compileMemoryWikiVault(config);

    const firstEntity = await fs.readFile(path.join(rootDir, "entities", "entity-0.md"), "utf8");
    const sourcePage = await fs.readFile(path.join(rootDir, "sources", "alpha.md"), "utf8");
    expect(firstEntity).toContain("[Alpha](sources/alpha.md)");
    expect(firstEntity).not.toContain("### Related Pages");
    expect(sourcePage).not.toContain("### Referenced By");
  });

  it("writes dashboard report pages when createDashboards is enabled", async () => {
    const { rootDir, config } = await createVault({
      rootDir: nextCaseRoot(),
      initialize: true,
    });

    await fs.writeFile(
      path.join(rootDir, "entities", "alpha.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "entity",
          id: "entity.alpha",
          title: "Alpha",
          sourceIds: ["source.alpha"],
          questions: ["What changed after launch?"],
          contradictions: ["Conflicts with source.beta"],
          confidence: 0.3,
          claims: [
            {
              id: "claim.alpha.db.postgres",
              claimKey: "claim.alpha.db",
              text: "Alpha uses PostgreSQL for production writes.",
              status: "supported",
              confidence: 0.4,
              evidence: [],
            },
          ],
        },
        body: "# Alpha\n",
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(rootDir, "concepts", "alpha-db.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "concept",
          id: "concept.alpha.db",
          title: "Alpha DB",
          sourceIds: ["source.alpha"],
          updatedAt: "2025-10-01T00:00:00.000Z",
          claims: [
            {
              id: "claim.alpha.db.mysql",
              claimKey: "claim.alpha.db",
              text: "Alpha uses MySQL for production writes.",
              status: "contested",
              confidence: 0.62,
              evidence: [
                {
                  sourceId: "source.alpha",
                  lines: "9-11",
                  updatedAt: "2025-10-01T00:00:00.000Z",
                },
              ],
            },
          ],
        },
        body: "# Alpha DB\n",
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(rootDir, "sources", "alpha.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "source",
          id: "source.alpha",
          title: "Alpha Source",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        body: "# Alpha Source\n",
      }),
      "utf8",
    );

    const result = await compileMemoryWikiVault(config);

    expect(result.pageCounts.report).toBeGreaterThanOrEqual(5);
    await expect(
      fs.readFile(path.join(rootDir, "reports", "open-questions.md"), "utf8"),
    ).resolves.toContain("[Alpha](entities/alpha.md): What changed after launch?");
    await expect(
      fs.readFile(path.join(rootDir, "reports", "contradictions.md"), "utf8"),
    ).resolves.toContain("Conflicts with source.beta: [Alpha](entities/alpha.md)");
    await expect(
      fs.readFile(path.join(rootDir, "reports", "contradictions.md"), "utf8"),
    ).resolves.toContain("`claim.alpha.db`");
    await expect(
      fs.readFile(path.join(rootDir, "reports", "low-confidence.md"), "utf8"),
    ).resolves.toContain("[Alpha](entities/alpha.md): confidence 0.30");
    await expect(
      fs.readFile(path.join(rootDir, "reports", "low-confidence.md"), "utf8"),
    ).resolves.toContain("Alpha uses PostgreSQL for production writes.");
    await expect(
      fs.readFile(path.join(rootDir, "reports", "claim-health.md"), "utf8"),
    ).resolves.toContain("Missing Evidence");
    await expect(
      fs.readFile(path.join(rootDir, "reports", "claim-health.md"), "utf8"),
    ).resolves.toContain("Alpha uses PostgreSQL for production writes.");
    await expect(
      fs.readFile(path.join(rootDir, "reports", "stale-pages.md"), "utf8"),
    ).resolves.toContain("[Alpha](entities/alpha.md): missing updatedAt");
    const agentDigest = JSON.parse(
      await fs.readFile(path.join(rootDir, ".openclaw-wiki", "cache", "agent-digest.json"), "utf8"),
    ) as {
      claimHealth: { missingEvidence: number; freshness: { unknown: number } };
      contradictionClusters: Array<{ key: string }>;
    };
    expect(agentDigest.claimHealth.missingEvidence).toBeGreaterThanOrEqual(1);
    expect(agentDigest.claimHealth.freshness.unknown).toBeGreaterThanOrEqual(1);
    expect(expectDigestCluster(agentDigest.contradictionClusters, "claim.alpha.db").key).toBe(
      "claim.alpha.db",
    );
  });

  it("skips dashboard report pages when createDashboards is disabled", async () => {
    const { rootDir, config } = await createVault({
      rootDir: nextCaseRoot(),
      initialize: true,
      config: {
        render: { createDashboards: false },
      },
    });

    await fs.writeFile(
      path.join(rootDir, "entities", "alpha.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "entity",
          id: "entity.alpha",
          title: "Alpha",
          sourceIds: ["source.alpha"],
          questions: ["What changed after launch?"],
        },
        body: "# Alpha\n",
      }),
      "utf8",
    );

    await compileMemoryWikiVault(config);

    await expectPathMissing(path.join(rootDir, "reports", "open-questions.md"));
  });

  it("writes agent directory, relationship, provenance, and privacy reports", async () => {
    const { rootDir, config } = await createVault({
      rootDir: nextCaseRoot(),
      initialize: true,
    });

    await fs.writeFile(
      path.join(rootDir, "entities", "brad.md"),
      renderWikiMarkdown({
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
      }),
      "utf8",
    );

    await compileMemoryWikiVault(config);

    await expect(
      fs.readFile(path.join(rootDir, "reports", "person-agent-directory.md"), "utf8"),
    ).resolves.toContain("Microsoft Teams");
    await expect(
      fs.readFile(path.join(rootDir, "reports", "relationship-graph.md"), "utf8"),
    ).resolves.toContain("collaborates-with");
    await expect(
      fs.readFile(path.join(rootDir, "reports", "provenance-coverage.md"), "utf8"),
    ).resolves.toContain("maintainer-whois: 1");
    await expect(
      fs.readFile(path.join(rootDir, "reports", "privacy-review.md"), "utf8"),
    ).resolves.toContain("confirm-before-use");

    const agentDigest = JSON.parse(
      await fs.readFile(path.join(rootDir, ".openclaw-wiki", "cache", "agent-digest.json"), "utf8"),
    ) as {
      pages: Array<{
        path: string;
        canonicalId?: string;
        aliases?: string[];
        personCard?: { lane?: string };
        relationshipCount?: number;
      }>;
    };
    const bradPage = expectDigestPage(agentDigest.pages, "entities/brad.md");
    expect(bradPage.canonicalId).toBe("maintainer.brad-groux");
    expect(bradPage.aliases).toEqual(["brad"]);
    expect(bradPage.personCard?.lane).toBe("Microsoft Teams");
    expect(bradPage.relationshipCount).toBe(1);
    await expect(
      fs.readFile(path.join(rootDir, ".openclaw-wiki", "cache", "claims.jsonl"), "utf8"),
    ).resolves.toContain('"evidenceKinds":["maintainer-whois"]');
  });

  it("ignores generated related links when computing backlinks on repeated compile", async () => {
    const { rootDir, config } = await createVault({
      rootDir: nextCaseRoot(),
      initialize: true,
    });

    await fs.writeFile(
      path.join(rootDir, "entities", "beta.md"),
      renderWikiMarkdown({
        frontmatter: { pageType: "entity", id: "entity.beta", title: "Beta" },
        body: "# Beta\n",
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(rootDir, "concepts", "gamma.md"),
      renderWikiMarkdown({
        frontmatter: { pageType: "concept", id: "concept.gamma", title: "Gamma" },
        body: "# Gamma\n\nSee [Beta](entities/beta.md).\n",
      }),
      "utf8",
    );

    await compileMemoryWikiVault(config);
    const second = await compileMemoryWikiVault(config);

    expect(second.updatedFiles).toStrictEqual([]);
    await expect(fs.readFile(path.join(rootDir, "entities", "beta.md"), "utf8")).resolves.toContain(
      "[Gamma](concepts/gamma.md)",
    );
    await expect(
      fs.readFile(path.join(rootDir, "concepts", "gamma.md"), "utf8"),
    ).resolves.not.toContain("### Referenced By");
  });
});
