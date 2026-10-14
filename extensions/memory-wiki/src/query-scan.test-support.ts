import fs from "node:fs/promises";
import path from "node:path";
import { renderWikiMarkdown } from "./markdown.js";
import { readWikiPagesTask } from "./query-pages.js";
import { sortWikiSearchResults, type WikiSearchMode } from "./query-scoring.js";
import type { createMemoryWikiTestHarness } from "./test-helpers.js";

/** More pages than two scan segments (`WIKI_SCAN_CHECKPOINT_PAGES` in query-pages.ts). */
export const TIED_VAULT_PAGES = 131;

type CreateVault = ReturnType<typeof createMemoryWikiTestHarness>["createVault"];

/** Pages that tie on score and title, so their order is listing order across segments. */
export async function createBatchedVault(createVault: CreateVault, pages: number) {
  const vault = await createVault({
    initialize: true,
    config: { search: { backend: "local", corpus: "wiki" } },
  });
  for (let index = 0; index < pages; index += 1) {
    await fs.writeFile(
      path.join(vault.rootDir, "sources", `page-${String(index).padStart(4, "0")}.md`),
      renderWikiMarkdown({
        frontmatter: { pageType: "source", id: `source.page-${index}`, title: "Lantern" },
        body: `# Lantern\n\ncobalt lantern ledger${index % 3 === 0 ? " cobalt" : ""}.\n`,
      }),
    );
  }
  return vault;
}

/** A whole-vault search task, as `searchWikiCorpus` submits it without digest candidates. */
export const scanTask = (rootDir: string) => ({
  rootDir,
  visibility: null,
  select: "search" as const,
  query: "cobalt lantern ledger",
  mode: "auto" as const,
  maxResults: 5,
});

/**
 * The whole-vault top `maxResults`, scored one page per read and sorted once, so it shares
 * no segment or task merge with the reader under test.
 */
export async function wholeVaultReference(
  rootDir: string,
  task: { query: string; mode: WikiSearchMode; maxResults: number },
) {
  const { relativePaths } = await readWikiPagesTask({ select: "list", rootDir });
  const scored = [];
  for (const relativePath of relativePaths) {
    const read = await readWikiPagesTask({
      ...task,
      rootDir,
      visibility: null,
      select: "search",
      relativePaths: [relativePath],
      maxResults: 1,
    });
    scored.push(...read.results);
  }
  return sortWikiSearchResults(scored).slice(0, task.maxResults);
}
