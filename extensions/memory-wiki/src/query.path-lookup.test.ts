// Memory Wiki tests cover wiki_get path lookups that resolve without reading every page.
import fs from "node:fs/promises";
import path from "node:path";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { afterEach, describe, expect, it } from "vitest";
import { compileMemoryWikiVault } from "./compile.js";
import { renderWikiMarkdown } from "./markdown.js";
import { readQueryableWikiPages } from "./query-pages.js";
import { getMemoryWikiPage } from "./query.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createVault } = createMemoryWikiTestHarness();
const PAGE_COUNT = 20;

afterEach(() => {
  __setFsSafeTestHooksForTest(undefined);
});

async function writePage(
  rootDir: string,
  relativePath: string,
  frontmatter: Record<string, unknown>,
) {
  const target = path.join(rootDir, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(
    target,
    renderWikiMarkdown({
      frontmatter: { title: path.basename(relativePath, ".md"), ...frontmatter },
      body: `# ${path.basename(relativePath, ".md")}\n\nbody of ${relativePath}\n`,
    }),
  );
}

async function createCompiledVault() {
  const vault = await createVault({
    initialize: true,
    config: { search: { backend: "local", corpus: "wiki" } },
  });
  for (let index = 0; index < PAGE_COUNT; index++) {
    await writePage(vault.rootDir, `concepts/p${index}.md`, {
      pageType: "concept",
      id: `concept.p${index}`,
    });
  }
  await compileMemoryWikiVault(vault.config);
  return vault;
}

function countPageOpens() {
  const opened: string[] = [];
  __setFsSafeTestHooksForTest({
    beforeOpen: async (filePath) => {
      if (filePath.endsWith(".md")) {
        opened.push(path.basename(filePath));
      }
    },
  });
  return opened;
}

describe("wiki_get lookups", () => {
  it.each([
    ["basename", "p7"],
    ["extensionless path", "concepts/p7"],
  ])("resolves a %s lookup by reading only the matching page", async (_form, lookup) => {
    const { config } = await createCompiledVault();
    const opened = countPageOpens();

    await expect(getMemoryWikiPage({ config, lookup })).resolves.toMatchObject({
      path: "concepts/p7.md",
      id: "concept.p7",
    });
    expect(opened).toEqual(["p7.md"]);
  });

  it("resolves id lookups and misses with exactly one full read", async () => {
    const { rootDir, config } = await createCompiledVault();
    const opened = countPageOpens();
    await readQueryableWikiPages(rootDir);
    const fullRead = opened.splice(0).length;

    await expect(getMemoryWikiPage({ config, lookup: "concept.p7" })).resolves.toMatchObject({
      path: "concepts/p7.md",
    });
    expect(opened).toHaveLength(fullRead);
    opened.splice(0);
    await expect(getMemoryWikiPage({ config, lookup: "absent" })).resolves.toBeNull();
    expect(opened).toHaveLength(fullRead);
  });

  it("reads one page when several share a basename and settles on the first in path order", async () => {
    const { rootDir, config } = await createCompiledVault();
    await writePage(rootDir, "entities/twin.md", { pageType: "entity" });
    await writePage(rootDir, "concepts/twin.md", { pageType: "concept" });
    const opened = countPageOpens();

    await expect(getMemoryWikiPage({ config, lookup: "twin" })).resolves.toMatchObject({
      path: "concepts/twin.md",
    });
    expect(opened).toEqual(["twin.md"]);
  });

  it("skips pages the session cannot see before settling on a later match", async () => {
    const { rootDir, config } = await createCompiledVault();
    await writePage(rootDir, "concepts/twin.md", {
      pageType: "concept",
      sourceType: "memory-bridge",
      bridgeAgentIds: ["secondary"],
    });
    await writePage(rootDir, "entities/twin.md", { pageType: "entity" });
    await compileMemoryWikiVault(config);

    const opened = countPageOpens();

    await expect(
      getMemoryWikiPage({ config, lookup: "twin", sandboxed: true, agentId: "main" }),
    ).resolves.toMatchObject({ path: "entities/twin.md" });
    expect(opened).toEqual(["twin.md", "twin.md"]);
    await expect(
      getMemoryWikiPage({ config, lookup: "twin", sandboxed: true, agentId: "secondary" }),
    ).resolves.toMatchObject({ path: "concepts/twin.md" });
  });

  it("keeps path-shaped matches ahead of ID matches", async () => {
    const { rootDir, config } = await createCompiledVault();
    await writePage(rootDir, "concepts/shared.md", { pageType: "concept", id: "concept.other" });
    await writePage(rootDir, "entities/zzz.md", { pageType: "entity", id: "shared" });
    await compileMemoryWikiVault(config);

    await expect(getMemoryWikiPage({ config, lookup: "shared" })).resolves.toMatchObject({
      path: "concepts/shared.md",
    });
  });

  it("returns the earlier-sorted page when a duplicate id appears after the last compile", async () => {
    const { rootDir, config } = await createCompiledVault();
    await writePage(rootDir, "concepts/a-new.md", { pageType: "concept", id: "concept.p7" });

    await expect(getMemoryWikiPage({ config, lookup: "concept.p7" })).resolves.toMatchObject({
      path: "concepts/a-new.md",
    });
  });

  it("finds pages added or renamed after the last compile and reports misses", async () => {
    const { rootDir, config } = await createCompiledVault();
    await writePage(rootDir, "entities/fresh.md", { pageType: "entity", id: "entity.fresh" });
    await writePage(rootDir, "concepts/p7.md", { pageType: "concept", id: "concept.renamed" });

    for (const lookup of ["fresh", "entity.fresh"]) {
      await expect(getMemoryWikiPage({ config, lookup })).resolves.toMatchObject({
        path: "entities/fresh.md",
      });
    }
    await expect(getMemoryWikiPage({ config, lookup: "concept.p7" })).resolves.toBeNull();
    await expect(getMemoryWikiPage({ config, lookup: "concept.renamed" })).resolves.toMatchObject({
      path: "concepts/p7.md",
    });
    await expect(getMemoryWikiPage({ config, lookup: "absent" })).resolves.toBeNull();
  });

  it("does not read pages that cannot match, so an unrelated refused page does not fail the lookup", async () => {
    const { rootDir, config } = await createCompiledVault();
    const outside = await createVault();
    await fs.mkdir(outside.rootDir, { recursive: true });
    const outsidePath = path.join(outside.rootDir, "outside.md");
    await fs.writeFile(outsidePath, "outside the vault\n");
    await writePage(rootDir, "concepts/unrelated.md", { pageType: "concept" });
    const unrelated = await fs.realpath(path.join(rootDir, "concepts/unrelated.md"));
    __setFsSafeTestHooksForTest({
      beforeOpen: async (filePath) => {
        if (path.resolve(filePath) === unrelated) {
          await fs.unlink(unrelated);
          await fs.symlink(outsidePath, unrelated);
        }
      },
    });

    await expect(getMemoryWikiPage({ config, lookup: "p7" })).resolves.toMatchObject({
      path: "concepts/p7.md",
    });
    await expect(getMemoryWikiPage({ config, lookup: "absent" })).rejects.toMatchObject({
      name: "FsSafeError",
    });
  });
});
