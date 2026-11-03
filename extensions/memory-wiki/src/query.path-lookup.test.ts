import fs from "node:fs/promises";
import path from "node:path";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { afterEach, describe, expect, it } from "vitest";
import { compileMemoryWikiVault } from "./compile.js";
import { getMemoryWikiPage } from "./query.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createVault } = createMemoryWikiTestHarness();
const PAGE_COUNT = 20;
const chmodFaultUnavailable = process.platform === "win32" || process.getuid?.() === 0;

afterEach(() => {
  __setFsSafeTestHooksForTest(undefined);
});

async function createCompiledVault() {
  const vault = await createVault({
    initialize: true,
    config: { search: { backend: "local", corpus: "wiki" } },
  });
  const page: typeof vault.page = (file, fields) => vault.page(file, fields, "");
  for (let index = 0; index < PAGE_COUNT; index++) {
    await page(`concepts/p${index}.md`, {
      pageType: "concept",
      id: `concept.p${index}`,
    });
  }
  await compileMemoryWikiVault(vault.config);
  type LookupOptions = Pick<Parameters<typeof getMemoryWikiPage>[0], "sandboxed" | "agentId">;
  const get = (lookup: string, options: LookupOptions = {}) =>
    getMemoryWikiPage({ config: vault.config, lookup, ...options });
  const expectPath = async (lookup: string, expected: string, options: LookupOptions = {}) =>
    expect(get(lookup, options)).resolves.toMatchObject({ path: expected });
  return { ...vault, page, get, expectPath };
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
  it("resolves an extensionless path by reading only the matching page", async () => {
    const { get } = await createCompiledVault();
    const opened = countPageOpens();
    await expect(get("concepts/p7")).resolves.toMatchObject({
      path: "concepts/p7.md",
      id: "concept.p7",
    });
    expect(opened).toEqual(["p7.md"]);
  });

  it("reads one page when several share a basename and settles on the first in path order", async () => {
    const { page, expectPath } = await createCompiledVault();
    await page("entities/twin.md", { pageType: "entity" });
    await page("concepts/twin.md", { pageType: "concept" });
    const opened = countPageOpens();
    await expectPath("twin", "concepts/twin.md");
    expect(opened).toEqual(["twin.md"]);
  });

  it("skips pages the session cannot see before settling on a later match", async () => {
    const { page, config, expectPath } = await createCompiledVault();
    await page("concepts/twin.md", {
      pageType: "concept",
      sourceType: "memory-bridge",
      bridgeAgentIds: ["secondary"],
    });
    await page("entities/twin.md", { pageType: "entity" });
    await compileMemoryWikiVault(config);

    const opened = countPageOpens();
    await expectPath("twin", "entities/twin.md", { sandboxed: true, agentId: "main" });
    expect(opened).toEqual(["twin.md", "twin.md"]);
    await expectPath("twin", "concepts/twin.md", { sandboxed: true, agentId: "secondary" });
  });

  it("keeps path-shaped matches ahead of ID matches", async () => {
    const { page, config, expectPath } = await createCompiledVault();
    await page("concepts/shared.md", { pageType: "concept", id: "concept.other" });
    await page("entities/zzz.md", { pageType: "entity", id: "shared" });
    await compileMemoryWikiVault(config);
    await expectPath("shared", "concepts/shared.md");
  });

  it("returns the earlier-sorted page when a duplicate id appears after the last compile", async () => {
    const { page, expectPath } = await createCompiledVault();
    await page("concepts/a-new.md", { pageType: "concept", id: "concept.p7" });
    await expectPath("concept.p7", "concepts/a-new.md");
  });

  it("finds pages added or renamed after the last compile and reports misses", async () => {
    const { page, get, expectPath } = await createCompiledVault();
    await page("entities/fresh.md", { pageType: "entity", id: "entity.fresh" });
    await page("concepts/p7.md", { pageType: "concept", id: "concept.renamed" });

    for (const lookup of ["fresh", "entity.fresh"]) {
      await expectPath(lookup, "entities/fresh.md");
    }
    await expect(get("concept.p7")).resolves.toBeNull();
    await expectPath("concept.renamed", "concepts/p7.md");
    await expect(get("absent")).resolves.toBeNull();
  });

  it.skipIf(chmodFaultUnavailable)(
    "does not read pages that cannot match, so an unrelated unreadable page does not fail the lookup",
    async () => {
      const { rootDir, page, get, expectPath } = await createCompiledVault();
      const unrelated = path.join(rootDir, "concepts", "unrelated.md");
      await page("concepts/unrelated.md", { pageType: "concept" });
      await fs.chmod(unrelated, 0o000);

      try {
        await expectPath("p7", "concepts/p7.md");
        // A miss falls back to reading every page, which reaches the unreadable one.
        await expect(get("absent")).rejects.toThrow(/EACCES/u);
      } finally {
        await fs.chmod(unrelated, 0o644);
      }
    },
  );
});
