import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compileMemoryWikiVault } from "./compile.js";
import * as wikiMarkdown from "./markdown.js";
import { renderWikiMarkdown } from "./markdown.js";
import { getMemoryWikiPage, searchMemoryWiki } from "./query.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createVault } = createMemoryWikiTestHarness();

afterEach(() => {
  vi.restoreAllMocks();
});

async function createReadVault(relativePath = "sources/alpha.md") {
  const vault = await createVault({
    initialize: true,
    config: { search: { backend: "local", corpus: "wiki" } },
  });
  const targetPath = path.join(vault.rootDir, relativePath);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(
    targetPath,
    renderWikiMarkdown({
      frontmatter: { pageType: "source", id: "source.alpha", title: "Alpha" },
      body: "# Alpha\n\nreadable line\n",
    }),
  );
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
    await fs.writeFile(
      path.join(rootDir, "entities", "claim-owner.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "entity",
          id: "entity.claim-owner",
          title: "Claim owner",
          claims: [{ id: relativePath, text: "A path-shaped claim ID.", status: "supported" }],
        },
        body: "# Claim owner\n\nClaim evidence.\n",
      }),
    );
    await compileMemoryWikiVault(config);

    await expect(getMemoryWikiPage({ config, lookup: relativePath })).resolves.toMatchObject({
      path: "entities/claim-owner.md",
      id: "entity.claim-owner",
    });
  });

  it.each(["directory"] as const)(
    "skips a compiled candidate replaced by %s state",
    async (kind) => {
      const { rootDir, config, relativePath } = await createReadVault();
      const stalePath = path.join(rootDir, "entities", "stale.md");
      await fs.writeFile(
        stalePath,
        renderWikiMarkdown({
          frontmatter: {
            pageType: "entity",
            title: "Alpha stale",
            claims: [{ id: "claim.stale", text: "Alpha evidence.", status: "supported" }],
          },
          body: "# Alpha stale\n",
        }),
      );
      await compileMemoryWikiVault(config);
      await fs.unlink(stalePath);
      if (kind === "directory") {
        await fs.mkdir(stalePath);
      }

      const results = await searchMemoryWiki({ config, query: "Alpha" });
      expect(results.some((page) => page.path === relativePath)).toBe(true);
      expect(results.some((page) => page.path === "entities/stale.md")).toBe(false);
      await expect(getMemoryWikiPage({ config, lookup: "claim.stale" })).resolves.toBeNull();
    },
  );

  it.each(["invalid"] as const)(
    "retains ID fallback when the canonical candidate is %s",
    async (kind) => {
      const { rootDir, config, targetPath, relativePath } = await createReadVault();
      await fs.unlink(targetPath);
      if (kind === "invalid") {
        await fs.writeFile(targetPath, "---\npageType: [\n---\n");
      } else if (kind === "directory") {
        await fs.mkdir(targetPath);
      }
      await fs.writeFile(
        path.join(rootDir, "sources", "fallback.md"),
        renderWikiMarkdown({
          frontmatter: { pageType: "source", id: relativePath, title: "Fallback" },
          body: "# Fallback\n",
        }),
      );

      await expect(getMemoryWikiPage({ config, lookup: relativePath })).resolves.toMatchObject({
        path: "sources/fallback.md",
      });
    },
  );

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

  it("never parses whole-vault pages on the calling thread (#166304)", async () => {
    const { rootDir, config, relativePath } = await createReadVault();
    await fs.writeFile(
      path.join(rootDir, "concepts", "beta.md"),
      renderWikiMarkdown({
        frontmatter: { pageType: "concept", id: "concept.beta", title: "Beta" },
        body: "# Beta\n\nanother readable line\n",
      }),
    );
    // Without a compiled digest every search reads the whole vault, and a basename
    // lookup resolves against every page; both parse each page with this function.
    const scan = vi.spyOn(wikiMarkdown, "scanWikiPageSummary");

    const results = await searchMemoryWiki({ config, query: "readable line" });
    const page = await getMemoryWikiPage({ config, lookup: "alpha" });

    expect(
      results
        .map((result) => result.path ?? "")
        .toSorted((left, right) => left.localeCompare(right)),
    ).toEqual(["concepts/beta.md", relativePath]);
    expect(page?.path).toBe(relativePath);
    expect(scan).not.toHaveBeenCalled();
  });
});
