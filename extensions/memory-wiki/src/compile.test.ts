import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compileMemoryWikiVault, refreshMemoryWikiIndexesAfterImport } from "./compile.js";
import { loadMemoryWikiCompiledCache, readMemoryWikiDashboardState } from "./compiled-cache.js";
import type { MemoryWikiPluginConfig } from "./config.js";
import { loadMemoryWikiVaultIdentity, loadMemoryWikiValidatedVaultIdentity } from "./log.js";
import { extractWikiLinks } from "./markdown-links.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createVault: createTestVault } = createMemoryWikiTestHarness();
const createVault = (config?: MemoryWikiPluginConfig) =>
  createTestVault({ initialize: true, config });

describe("compileMemoryWikiVault", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps changed imports compile-required when auto-compile is disabled", async () => {
    const { config, page, read } = await createVault({
      ingest: { autoCompile: false },
      render: { createBacklinks: false, createDashboards: false },
    });
    const writeSource = (value: string) =>
      page(
        "sources/cache-only.md",
        { pageType: "source", sourceType: "chatgpt-export", title: "Cache only" },
        `# Cache only\n\n## Auto Digest\n- First user line: ${value}\n`,
      );
    await writeSource("before");
    await compileMemoryWikiVault(config);
    const snapshotBefore = await loadMemoryWikiCompiledCache(config);
    const indexBefore = await read("index.md");

    await writeSource("after");
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
    await expect(read("index.md")).resolves.toBe(indexBefore);
  });

  it("preserves human and empty pages while rebuilding indexes and clickable related links", async () => {
    const { config, page, write, read } = await createVault({
      render: { createDashboards: false },
    });
    const relativePath = "sources/meeting notes.md";
    const notesLine = "- 中文 🦀 \uFFFD tail";
    const sourcePath = await page(
      relativePath,
      { pageType: "source", id: "source.notes", title: "Meeting notes" },
      `# Meeting notes\n\n[Plan](../entities/plan.md)\n\n## Human Notes\n\n${notesLine}\n`,
    );
    await page("entities/plan.md", { pageType: "entity", id: "entity.plan", title: "Plan" });
    const source = await read(relativePath);
    const emptyPages = [
      ["sources/empty.md", ""],
      ["sources/whitespace.md", " \n\t"],
    ] as const;
    const emptyPaths = await Promise.all(emptyPages.map(([file, bytes]) => write(file, bytes)));
    const preserved = await compileMemoryWikiVault(config, { sourcePageWrites: "preserve" });

    await expect(read(relativePath)).resolves.toBe(source);
    await expect(read("index.md")).resolves.toContain(
      "[Meeting notes](<sources/meeting notes.md>)",
    );
    expect(extractWikiLinks(await read("index.md"), "index.md")).toContain(relativePath);
    expect(preserved.updatedFiles).not.toContain(sourcePath);
    const snapshot = expectDefined(await loadMemoryWikiCompiledCache(config), "compiled cache");
    expect(snapshot.digest.pages.map((entry) => entry.path)).toContain(relativePath);
    const normal = await compileMemoryWikiVault(config);
    expect(normal.updatedFiles).toContain(sourcePath);
    await expect(read(relativePath)).resolves.toContain("<!-- openclaw:wiki:related:start -->");
    await expect(read(relativePath)).resolves.toContain(notesLine);
    await expect(read("entities/plan.md")).resolves.toContain(
      "[Meeting notes](<../sources/meeting notes.md>)",
    );
    for (const [file, bytes] of emptyPages) {
      await expect(read(file)).resolves.toBe(bytes);
    }
    for (const file of emptyPaths) {
      expect(normal.updatedFiles).not.toContain(file);
    }
  });

  it("rejects directory-index syntax-error frontmatter without changing its bytes", async () => {
    const { config, write, read } = await createVault({ render: { createDashboards: false } });
    const original =
      '---\npageType: report\nsourceIds:\n  - **MEMORY.md line 235**:"some quoted, value"\n---\n\n# Existing Index\n\nKeep this body.';
    await write("sources/index.md", original);
    await expect(compileMemoryWikiVault(config)).rejects.toThrow("Unexpected scalar");
    await expect(read("sources/index.md")).resolves.toBe(original);
  });

  it("bounds concurrent page reads and stops the queue after abort", async () => {
    const { rootDir, config, page } = await createVault();

    for (let index = 0; index < 24; index += 1) {
      await page(`sources/page-${index}.md`, { title: `Page ${index}` });
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

  it.each(["initial scan", "dashboard refresh"])(
    "keeps scanned fingerprints and external edits separate during %s",
    async (phase) => {
      const { rootDir, config, write, page, read } = await createVault({
        render: { createBacklinks: false, createDashboards: phase === "dashboard refresh" },
      });
      const sourcePath = await write("sources/edited.md", "# Before\n");
      if (phase === "dashboard refresh") {
        await compileMemoryWikiVault(config);
        await page("entities/new.md", { pageType: "entity", title: "New", questions: ["New?"] });
      }
      const readFile = fs.readFile.bind(fs);
      const trigger =
        phase === "initial scan" ? sourcePath : path.join(rootDir, "reports/open-questions.md");
      let reads = 0;
      const spy = vi
        .spyOn(fs, "readFile")
        .mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
          const bytes = await readFile(...args);
          if (args[0] === trigger && ++reads === (phase === "initial scan" ? 1 : 2)) {
            await write("sources/edited.md", "# After\n");
          }
          return bytes;
        });
      const cachedTitle = async () =>
        (await loadMemoryWikiCompiledCache(config))?.digest.pages.find(
          (entry) => entry.path === "sources/edited.md",
        )?.title;

      await compileMemoryWikiVault(config);
      spy.mockRestore();
      expect(reads).toBeGreaterThanOrEqual(phase === "initial scan" ? 1 : 2);
      expect(await cachedTitle()).toBe("Before");
      await expect(read("sources/edited.md")).resolves.toBe("# After\n");
      // Activation must reject the stale fingerprint; a fresh compile adopts the edit.
      expect(
        (await loadMemoryWikiValidatedVaultIdentity(rootDir)).compiledCachePublicationId,
      ).toBeNull();
      await compileMemoryWikiVault(config);
      expect(await cachedTitle()).toBe("After");
    },
  );

  it("preserves scan ordering, invalid fingerprints, projections, and reports after writes", async () => {
    const { rootDir, config, page, write, read } = await createVault();
    const sources = ["sources/a-stable.md", "sources/z-changed.md"] as const;
    for (const [relative, id] of [
      [sources[0], "stable"],
      [sources[1], "changed"],
    ] as const) {
      await page(
        relative,
        {
          pageType: "source",
          id,
          title: "Same title",
          sourceType: "chatgpt-export",
        },
        `# Same title\n\n## Auto Digest\n- First user line: ${id} insight\n`,
      );
    }
    await compileMemoryWikiVault(config);
    await write("concepts/broken.md", "---\n- invalid mapping\n---\n# Broken\n");
    await page("entities/brad.md", {
      pageType: "entity",
      id: "entity.brad",
      sourceIds: ["changed"],
      questions: ["A new question?"],
      title: "Brad Groux",
      entityType: "person",
      canonicalId: "maintainer.brad-groux",
      aliases: ["brad", "bgroux"],
      privacyTier: "local-private",
      relationships: [
        {
          targetTitle: "Alice",
          kind: "collaborates-with",
        },
      ],
      personCard: {
        email: "brad@example.com",
        lane: "Microsoft Teams",
        privacyTier: "confirm-before-use",
      },
      claims: [
        {
          text: "Brad is useful for Microsoft Teams routing.",
          status: "supported",
          evidence: [{ kind: "maintainer-whois", sourceId: "source.maintainers" }],
        },
      ],
    });

    const reads = vi.spyOn(fs, "readFile");
    const result = await compileMemoryWikiVault(config);
    expect(
      reads.mock.calls.filter(([file]) => file === path.join(rootDir, sources[0])),
    ).toHaveLength(1);
    expect(result.updatedFiles).not.toContain(path.join(rootDir, sources[0]));
    expect(result.updatedFiles).toContain(path.join(rootDir, sources[1]));
    expect(result.frontmatterErrors).toEqual([
      expect.objectContaining({ relativePath: "concepts/broken.md" }),
    ]);
    expect(
      result.pages
        .filter((entry) => entry.title === "Same title")
        .map((entry) => entry.relativePath),
    ).toEqual(sources);

    for (const [name, content] of [
      ["person-agent-directory", "[Brad Groux](../entities/brad.md)"],
      ["relationship-graph", "[Brad Groux](../entities/brad.md) -> Alice"],
      ["provenance-coverage", "maintainer-whois: 1"],
      ["privacy-review", "[Brad Groux](../entities/brad.md)"],
    ]) {
      await expect(read(`reports/${name}.md`)).resolves.toContain(content);
    }

    const snapshot = expectDefined(await loadMemoryWikiCompiledCache(config), "compiled cache");
    const { digest: agentDigest, claims } = snapshot;
    const identity = await loadMemoryWikiVaultIdentity(rootDir);
    expect(identity.compiledCachePublicationId).not.toBeNull();
    expect(await loadMemoryWikiValidatedVaultIdentity(rootDir)).toEqual(identity);
    for (const insight of ["stable insight", "changed insight"]) {
      expect(JSON.stringify(snapshot.dashboards.importInsights)).toContain(insight);
    }
    await expect(read("reports/open-questions.md")).resolves.toContain("A new question?");

    const bradPage = expectDefined(
      agentDigest.pages.find((entry) => entry.path === "entities/brad.md"),
      "Brad digest page",
    );
    expect(bradPage).toMatchObject({
      canonicalId: "maintainer.brad-groux",
      aliases: ["brad", "bgroux"],
      personCard: {
        lane: "Microsoft Teams",
        emails: ["brad@example.com"],
        privacyTier: "confirm-before-use",
      },
      relationshipCount: 1,
    });
    expect(claims.flatMap((claim) => claim.evidenceKinds ?? [])).toContain("maintainer-whois");
  });
  it.each(["entities/router.md", "index.md", "reports/open-questions.md"])(
    "refuses to rewrite malformed UTF-8 in %s and leaves it unchanged",
    async (relativePath) => {
      const { config, write } = await createVault();
      const malformed = Buffer.concat([
        Buffer.from(
          "---\npageType: entity\nid: entity.router\ntitle: Router\nstatus: active\n---\n# Router\n\n## Human Notes\n\nlatin1: caf",
          "utf8",
        ),
        Buffer.from([0xff]),
        Buffer.from(" keeps dropping\n", "utf8"),
      ]);
      const pagePath = await write(relativePath, malformed);

      await expect(compileMemoryWikiVault(config)).rejects.toMatchObject({
        name: "WikiPageNotUtf8Error",
        message: expect.stringContaining(relativePath),
      });
      // The rewrite never happened: the undecodable byte survived untouched.
      expect(await fs.readFile(pagePath)).toEqual(malformed);
    },
  );
});
