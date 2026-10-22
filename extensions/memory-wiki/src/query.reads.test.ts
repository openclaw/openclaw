import fs from "node:fs/promises";
import path from "node:path";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compileMemoryWikiVault } from "./compile.js";
import { renderWikiMarkdown } from "./markdown.js";
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

function writePage(file: string, frontmatter: Record<string, unknown>, body: string) {
  return fs.writeFile(file, renderWikiMarkdown({ frontmatter, body }));
}

async function createReadVault(
  frontmatter: Record<string, unknown> = { pageType: "source", id: "source.alpha", title: "Alpha" },
  body = "# Alpha\n\nreadable line\n",
) {
  const vault = await createVault({
    initialize: true,
    config: { search: { backend: "local", corpus: "wiki" } },
  });
  const relativePath = "sources/alpha.md";
  const targetPath = path.join(vault.rootDir, relativePath);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await writePage(targetPath, frontmatter, body);
  return { ...vault, targetPath, relativePath };
}

describe("wiki query page reads", () => {
  it.each(["large", "hardlinked"] as const)(
    "keeps exact, basename and ID reads equivalent for a %s page",
    async (kind) => {
      const { rootDir, config, targetPath, relativePath } = await createReadVault();
      if (kind === "large") {
        await fs.appendFile(targetPath, ("x".repeat(1023) + "\n").repeat(16 * 1024));
      } else {
        await fs.link(targetPath, path.join(rootDir, "_attachments", "alpha-link.md"));
      }
      for (const lookup of [relativePath, "alpha", "source.alpha"]) {
        await expect(
          getMemoryWikiPage({ config, lookup, fromLine: 4, lineCount: 1 }),
        ).resolves.toMatchObject({ path: relativePath, content: "readable line" });
      }
    },
  );

  it("preserves compiled claim precedence over a matching canonical page path", async () => {
    const { rootDir, config, relativePath } = await createReadVault();
    await writePage(
      path.join(rootDir, "entities", "claim-owner.md"),
      {
        pageType: "entity",
        id: "entity.claim-owner",
        title: "Claim owner",
        claims: [{ id: relativePath, text: "A path-shaped claim ID.", status: "supported" }],
      },
      "# Claim owner\n\nClaim evidence.\n",
    );
    await compileMemoryWikiVault(config);
    await expect(getMemoryWikiPage({ config, lookup: relativePath })).resolves.toMatchObject({
      path: "entities/claim-owner.md",
      id: "entity.claim-owner",
    });
  });

  it("skips a compiled candidate replaced by directory state", async () => {
    const { rootDir, config, relativePath } = await createReadVault();
    const stalePath = path.join(rootDir, "entities", "stale.md");
    await writePage(
      stalePath,
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
    const results = await searchMemoryWiki({ config, query: "Alpha" });
    expect(results.some((page) => page.path === relativePath)).toBe(true);
    expect(results.some((page) => page.path === "entities/stale.md")).toBe(false);
    await expect(getMemoryWikiPage({ config, lookup: "claim.stale" })).resolves.toBeNull();
  });

  it("retains ID fallback when the canonical candidate is invalid", async () => {
    const { rootDir, config, targetPath, relativePath } = await createReadVault();
    await fs.unlink(targetPath);
    await fs.writeFile(targetPath, "---\npageType: [\n---\n");
    await writePage(
      path.join(rootDir, "sources", "fallback.md"),
      { pageType: "source", id: relativePath, title: "Fallback" },
      "# Fallback\n",
    );
    await expect(getMemoryWikiPage({ config, lookup: relativePath })).resolves.toMatchObject({
      path: "sources/fallback.md",
    });
  });

  // Exact reads open the lookup path directly and compiled candidates are read by
  // path, so a page replaced by a symlink is reached and must be refused. Directory
  // walks skip symlinks, which is why the whole-vault routes cannot reach one here.
  it.each(["exact", "search"] as const)(
    "rejects a compiled or exact page swapped outside the vault during %s reads",
    async (route) => {
      const { config, targetPath, relativePath } = await createReadVault();
      const outside = await createReadVault();
      await fs.writeFile(
        outside.targetPath,
        (await fs.readFile(outside.targetPath, "utf8")).replace(
          "readable line",
          "outside-vault marker",
        ),
      );
      if (route === "search") {
        await compileMemoryWikiVault(config);
      }
      await fs.unlink(targetPath);
      await fs.symlink(outside.targetPath, targetPath);
      const read =
        route === "search"
          ? searchMemoryWiki({ config, query: "Alpha" })
          : getMemoryWikiPage({ config, lookup: relativePath });

      await expect(read).rejects.toMatchObject({
        name: "FsSafeError",
        code: expect.stringMatching(/symlink|path-mismatch/u),
      });
    },
  );

  it("keeps whole-vault searches and id lookups off the calling thread (#166304)", async () => {
    const { rootDir, config, relativePath } = await createReadVault();
    await writePage(
      path.join(rootDir, "concepts", "beta.md"),
      { pageType: "concept", id: "concept.beta", title: "Beta" },
      "# Beta\n\nanother readable line\n",
    );
    const opened = recordPageOpens();

    // Without a compiled digest the search reads every page, and an id lookup or a miss
    // resolves against every page; only the lookup's matched page is read here again.
    const results = await searchMemoryWiki({ config, query: "readable line" });
    expect(opened).toEqual([]);
    await expect(getMemoryWikiPage({ config, lookup: "source.alpha" })).resolves.toMatchObject({
      path: relativePath,
    });
    await expect(getMemoryWikiPage({ config, lookup: "absent" })).resolves.toBeNull();

    expect(sortedPaths(results)).toEqual(["concepts/beta.md", relativePath]);
    expect(opened).toEqual(["alpha.md"]);
  });

  it.skipIf(chmodFaultUnavailable)(
    "reads only compiled metadata candidates for distributed query tokens",
    async () => {
      const { rootDir, config, targetPath, relativePath } = await createReadVault();
      await writePage(
        targetPath,
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
      await writePage(unrelatedPath, { pageType: "source", title: "Unrelated" }, "# Unrelated\n");
      const query = "cobalt quartz amber lantern";
      const liveResults = await searchMemoryWiki({ config, query, maxResults: 1 });
      expect(liveResults[0]?.path).toBe(relativePath);
      await compileMemoryWikiVault(config);
      // A whole-vault read would fail on this page, so the search must stay on the
      // candidates the digest admits for the distributed tokens.
      await fs.chmod(unrelatedPath, 0o000);

      try {
        await expect(searchMemoryWiki({ config, query, maxResults: 1 })).resolves.toEqual(
          liveResults,
        );
      } finally {
        await fs.chmod(unrelatedPath, 0o644);
      }
    },
  );

  it("backfills underfilled digest candidates from the rest of the vault", async () => {
    const { rootDir, config, relativePath } = await createReadVault();
    await writePage(
      path.join(rootDir, "sources", "watch.md"),
      { pageType: "source", id: "source.watch", title: "Watch", aliases: ["keeps watch"] },
      "# Watch\n\nNight shift.\n",
    );
    await writePage(
      path.join(rootDir, "entities", "keeper.md"),
      { pageType: "entity", id: "entity.keeper", title: "Lantern Keeper" },
      "# Lantern Keeper\n\nKeeps the harbor ledger.\n",
    );
    await compileMemoryWikiVault(config);

    // Only the alias is in the digest; the keeper matches in its body alone.
    const results = await searchMemoryWiki({ config, query: "keeps", maxResults: 10 });

    expect(sortedPaths(results)).toEqual(["entities/keeper.md", "sources/watch.md"]);
    expect(results.map((result) => result.path)).not.toContain(relativePath);
  });
});
