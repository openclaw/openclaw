import fs from "node:fs/promises";
import path from "node:path";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compileMemoryWikiVault } from "./compile.js";
import { loadMemoryWikiCompiledCache } from "./compiled-cache.js";
import { buildDigestCandidatePaths } from "./query-scoring.js";
import { getMemoryWikiPage, searchMemoryWiki } from "./query.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createVault } = createMemoryWikiTestHarness();

const chmodFaultUnavailable = process.platform === "win32" || process.getuid?.() === 0;

afterEach(() => {
  __setFsSafeTestHooksForTest(undefined);
  vi.restoreAllMocks();
});

function sortedPaths(results: Array<{ path?: string }>): string[] {
  return results
    .map((result) => result.path ?? "")
    .toSorted((left, right) => left.localeCompare(right));
}

/** Page opens on this thread; the reader pool's workers open pages without this hook. */
function recordPageOpens() {
  const opened: string[] = [];
  __setFsSafeTestHooksForTest({
    beforeOpen: (filePath) => {
      if (filePath.endsWith(".md")) {
        opened.push(path.basename(filePath));
      }
    },
  });
  return opened;
}

async function createReadVault() {
  const vault = await createVault({
    initialize: true,
    config: { search: { backend: "local", corpus: "wiki" } },
  });
  const relativePath = "sources/alpha.md";
  const targetPath = await vault.page(
    relativePath,
    { pageType: "source", id: "source.alpha", title: "Alpha" },
    "# Alpha\n\nreadable line\n",
  );
  return {
    ...vault,
    targetPath,
    relativePath,
    get: (lookup: string, fromLine?: number, lineCount?: number) =>
      getMemoryWikiPage({ config: vault.config, lookup, fromLine, lineCount }),
    search: (query: string, maxResults?: number) =>
      searchMemoryWiki({ config: vault.config, query, maxResults }),
  };
}

describe("wiki query page reads", () => {
  it.each(["NFC", "NFD"] as const)(
    "matches canonically equivalent %s text in live pages and compiled metadata",
    async (form) => {
      const { page, config } = await createVault({
        initialize: true,
        config: {
          search: { backend: "local", corpus: "wiki" },
          render: { createDashboards: false },
        },
      });
      const search = (query: string) => searchMemoryWiki({ config, query });
      const text = "Café 한국어".normalize(form);
      const query = "한국어 CAFÉ".normalize(form === "NFC" ? "NFD" : "NFC");
      const paths = ["title", "alias", "claim", "body"].map((field) => `entities/${field}.md`);
      for (const field of ["title", "alias", "claim", "body"]) {
        await page(
          `entities/${field}.md`,
          {
            pageType: "entity",
            id: `entity.${field}`,
            title: field === "title" ? text : "Neutral",
            ...(field === "alias" ? { aliases: [text] } : {}),
            ...(field === "claim"
              ? { claims: [{ id: "claim.observation", text, status: "supported" }] }
              : {}),
          },
          `# Neutral\n\n${field === "body" ? text : "Ordinary context."}\n`,
        );
      }
      const live = await search(query);
      expect(sortedPaths(live)).toEqual(paths.toSorted());
      expect(live.find((result) => result.path === "entities/title.md")?.title).toBe(text);
      for (const field of ["claim", "body"]) {
        expect(live.find((result) => result.path === `entities/${field}.md`)?.snippet).toBe(text);
      }

      await compileMemoryWikiVault(config);
      const snapshot = await loadMemoryWikiCompiledCache(config);
      if (!snapshot) {
        throw new Error("Expected a compiled Wiki snapshot");
      }
      expect(
        buildDigestCandidatePaths({ snapshot, query, maxResults: 10, mode: "auto" }).toSorted(),
      ).toEqual(paths.filter((candidate) => candidate !== "entities/body.md").toSorted());
      await expect(search(query)).resolves.toEqual(live);
      await expect(search("Ordinary context")).resolves.toHaveLength(3);
      await expect(search("NeverRecordedNebula")).resolves.toEqual([]);
    },
  );

  it.each(["large", "hardlinked"] as const)(
    "keeps exact, basename and ID reads equivalent for a %s page",
    async (kind) => {
      const { rootDir, get, targetPath, relativePath } = await createReadVault();
      if (kind === "large") {
        await fs.appendFile(targetPath, ("x".repeat(1023) + "\n").repeat(16 * 1024));
      } else {
        await fs.link(targetPath, path.join(rootDir, "_attachments", "alpha-link.md"));
      }
      for (const lookup of [relativePath, "alpha", "source.alpha"]) {
        await expect(get(lookup, 4, 1)).resolves.toMatchObject({
          path: relativePath,
          content: "readable line",
        });
      }
    },
  );

  it("preserves compiled claim precedence over a matching canonical page path", async () => {
    const { page, config, get, relativePath } = await createReadVault();
    await page(
      "entities/claim-owner.md",
      {
        pageType: "entity",
        id: "entity.claim-owner",
        title: "Claim owner",
        claims: [{ id: relativePath, text: "A path-shaped claim ID.", status: "supported" }],
      },
      "# Claim owner\n\nClaim evidence.\n",
    );
    await compileMemoryWikiVault(config);
    await expect(get(relativePath)).resolves.toMatchObject({
      path: "entities/claim-owner.md",
      id: "entity.claim-owner",
    });
  });

  it("skips a compiled candidate replaced by directory state", async () => {
    const { rootDir, config, page, get, search, relativePath } = await createReadVault();
    const stalePath = path.join(rootDir, "entities", "stale.md");
    await page(
      "entities/stale.md",
      {
        pageType: "entity",
        title: "Alpha stale",
        claims: [{ id: "claim.stale", text: "Alpha evidence.", status: "supported" }],
      },
      "# Alpha stale\n",
    );
    await compileMemoryWikiVault(config);
    await fs.unlink(stalePath);
    await fs.mkdir(stalePath);
    const results = await search("Alpha");
    expect(results.some((result) => result.path === relativePath)).toBe(true);
    expect(results.some((result) => result.path === "entities/stale.md")).toBe(false);
    await expect(get("claim.stale")).resolves.toBeNull();
  });

  it("retains ID fallback when the canonical candidate is invalid", async () => {
    const { page, get, targetPath, relativePath } = await createReadVault();
    await fs.writeFile(targetPath, "---\npageType: [\n---\n");
    await page(
      "sources/fallback.md",
      { pageType: "source", id: relativePath, title: "Fallback" },
      "# Fallback\n",
    );
    await expect(get(relativePath)).resolves.toMatchObject({
      path: "sources/fallback.md",
    });
  });

  // Exact reads open the lookup path directly and compiled candidates are read by
  // path, so a page replaced by a symlink is reached and must be refused. Directory
  // walks skip symlinks, which is why the whole-vault routes cannot reach one here.
  it.each(["exact", "search"] as const)(
    "rejects a compiled or exact page swapped outside the vault during %s reads",
    async (route) => {
      const { config, get, search, targetPath, relativePath } = await createReadVault();
      const outside = await createReadVault();
      await fs.writeFile(outside.targetPath, "# Alpha\n\noutside-vault marker\n");
      if (route === "search") {
        await compileMemoryWikiVault(config);
      }
      await fs.unlink(targetPath);
      await fs.symlink(outside.targetPath, targetPath);
      const read = route === "search" ? search("Alpha") : get(relativePath);

      await expect(read).rejects.toMatchObject({
        name: "FsSafeError",
        code: expect.stringMatching(/symlink|path-mismatch/u),
      });
    },
  );

  it("keeps whole-vault searches and id lookups off the calling thread (#166304)", async () => {
    const { page, get, search, relativePath } = await createReadVault();
    await page(
      "concepts/beta.md",
      { pageType: "concept", id: "concept.beta", title: "Beta" },
      "# Beta\n\nanother readable line\n",
    );
    const opened = recordPageOpens();

    // Without a compiled digest the search reads every page, and an id lookup or a miss
    // resolves against every page; only the lookup's matched page is read here again.
    const results = await search("readable line");
    expect(opened).toEqual([]);
    await expect(get("source.alpha")).resolves.toMatchObject({
      path: relativePath,
    });
    await expect(get("absent")).resolves.toBeNull();

    expect(sortedPaths(results)).toEqual(["concepts/beta.md", relativePath]);
    expect(opened).toEqual(["alpha.md"]);
  });

  it.skipIf(chmodFaultUnavailable)(
    "reads only compiled metadata candidates for distributed query tokens",
    async () => {
      const { rootDir, config, page, search, relativePath } = await createReadVault();
      await page(
        relativePath,
        {
          pageType: "source",
          id: "source.quartz",
          title: "Cobalt",
          aliases: ["amber"],
          questions: ["lantern"],
        },
        "# Cobalt\n\nSelected evidence.\n",
      );
      const unrelatedPath = path.join(rootDir, "sources", "unrelated.md");
      await page("sources/unrelated.md", { pageType: "source", title: "Unrelated" });
      const query = "cobalt quartz amber lantern";
      const liveResults = await search(query, 1);
      expect(liveResults[0]?.path).toBe(relativePath);
      await compileMemoryWikiVault(config);
      // A whole-vault read would fail on this page, so the search must stay on the
      // candidates the digest admits for the distributed tokens.
      await fs.chmod(unrelatedPath, 0o000);

      try {
        await expect(search(query, 1)).resolves.toEqual(liveResults);
      } finally {
        await fs.chmod(unrelatedPath, 0o644);
      }
    },
  );

  it("backfills underfilled digest candidates from the rest of the vault", async () => {
    const { page, search, config, relativePath } = await createReadVault();
    await page(
      "sources/watch.md",
      { pageType: "source", id: "source.watch", title: "Watch", aliases: ["keeps watch"] },
      "# Watch\n\nNight shift.\n",
    );
    await page(
      "entities/keeper.md",
      { pageType: "entity", id: "entity.keeper", title: "Lantern Keeper" },
      "# Lantern Keeper\n\nKeeps the harbor ledger.\n",
    );
    await compileMemoryWikiVault(config);

    // Only the alias is in the digest; the keeper matches in its body alone.
    const results = await search("keeps", 10);

    expect(sortedPaths(results)).toEqual(["entities/keeper.md", "sources/watch.md"]);
    expect(results.map((result) => result.path)).not.toContain(relativePath);
  });
});
