import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderWikiMarkdown } from "./markdown.js";
import { getMemoryWikiPage, searchMemoryWiki } from "./query.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createVault } = createMemoryWikiTestHarness();

// Several 64-page scan segments, with the best pages spread across them.
const PAGE_COUNT = 200;
const isBoosted = (index: number) => index % 50 === 37;
const pagePath = (index: number) => `sources/page-${String(index).padStart(4, "0")}.md`;

async function createSegmentedVault() {
  const vault = await createVault({
    initialize: true,
    config: { search: { backend: "local", corpus: "wiki" } },
  });
  for (let index = 0; index < PAGE_COUNT; index += 1) {
    await fs.writeFile(
      path.join(vault.rootDir, pagePath(index)),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "source",
          id: `source.page-${index}`,
          title: isBoosted(index) ? "Cobalt lantern ledger" : "Archive",
        },
        body: "# Archive\n\ncobalt lantern ledger\n",
      }),
    );
  }
  return vault;
}

// Built from the fixture alone: title matches rank first; equal pages keep listing order.
function expectedTopPaths(maxResults: number): string[] {
  const indexes = Array.from({ length: PAGE_COUNT }, (_, index) => index);
  return [...indexes.filter(isBoosted), ...indexes.filter((index) => !isBoosted(index))]
    .slice(0, maxResults)
    .map(pagePath);
}

describe("memory wiki whole-vault scans", () => {
  it("keep ranking and id lookups exact while concurrent scans hand off workers", async () => {
    const { config } = await createSegmentedVault();
    const search = (maxResults: number) =>
      searchMemoryWiki({ config, query: "cobalt lantern ledger", maxResults });

    // More scans than the pool has workers, so running scans yield at their checkpoints
    // and are resubmitted for the pages they have not read yet.
    const [few, many, fewAgain, manyAgain, first, last, miss] = await Promise.all([
      search(5),
      search(70),
      search(5),
      search(70),
      getMemoryWikiPage({ config, lookup: "source.page-0" }),
      getMemoryWikiPage({ config, lookup: `source.page-${PAGE_COUNT - 1}` }),
      getMemoryWikiPage({ config, lookup: "source.absent" }),
    ]);

    for (const [results, maxResults] of [
      [few, 5],
      [fewAgain, 5],
      [many, 70],
      [manyAgain, 70],
    ] as const) {
      expect(results.map((result) => result.path)).toEqual(expectedTopPaths(maxResults));
    }
    expect(first?.path).toBe(pagePath(0));
    expect(last?.path).toBe(pagePath(PAGE_COUNT - 1));
    expect(miss).toBeNull();
  });
});
