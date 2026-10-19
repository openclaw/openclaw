import fs from "node:fs/promises";
import path from "node:path";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compileMemoryWikiVault } from "./compile.js";
import { renderWikiMarkdown } from "./markdown.js";
import { getMemoryWikiPage, searchMemoryWiki } from "./query.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createVault } = createMemoryWikiTestHarness();

afterEach(() => {
  __setFsSafeTestHooksForTest(undefined);
  vi.restoreAllMocks();
});

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
  it("reads only compiled metadata candidates for distributed query tokens", async () => {
    const { rootDir, config, targetPath, relativePath } = await createReadVault(
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
    const openedPages: string[] = [];
    __setFsSafeTestHooksForTest({
      beforeOpen: (filePath) => {
        if (filePath.endsWith(".md")) {
          openedPages.push(filePath);
        }
      },
    });
    await expect(searchMemoryWiki({ config, query, maxResults: 1 })).resolves.toEqual(liveResults);
    expect(openedPages).toContain(targetPath);
    expect(openedPages).not.toContain(unrelatedPath);
  });

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

  it.each(["exact", "basename", "search"] as const)(
    "rejects a page swapped outside the vault during %s reads",
    async (route) => {
      const { config, targetPath, relativePath } = await createReadVault();
      const outside = await createReadVault();
      const canonicalTarget = await fs.realpath(targetPath);
      await fs.writeFile(
        outside.targetPath,
        (await fs.readFile(outside.targetPath, "utf8")).replace(
          "readable line",
          "outside-vault marker",
        ),
      );
      let swapped = false;
      const swap = async () => {
        if (swapped) {
          return;
        }
        swapped = true;
        await fs.unlink(targetPath);
        await fs.symlink(outside.targetPath, targetPath);
      };
      __setFsSafeTestHooksForTest({
        beforeOpen: async (filePath) => {
          if (path.resolve(filePath) === canonicalTarget) {
            await swap();
          }
        },
      });
      const readdir = vi.spyOn(fs, "readdir");
      const read =
        route === "search"
          ? searchMemoryWiki({ config, query: "Alpha" })
          : getMemoryWikiPage({ config, lookup: route === "exact" ? relativePath : "alpha" });

      await expect(read).rejects.toMatchObject({
        name: "FsSafeError",
        code: expect.stringMatching(/symlink|path-mismatch/u),
      });
      expect(swapped).toBe(true);
      if (route === "exact") {
        expect(readdir).not.toHaveBeenCalled();
      }
    },
  );
});
