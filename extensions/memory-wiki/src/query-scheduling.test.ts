import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWikiMarkdown } from "./markdown.js";
import * as queryReader from "./query-reader.js";
import { closeMemoryWikiQueryReader, readMemoryWikiPages } from "./query-reader.js";
import { getMemoryWikiPage, searchMemoryWiki } from "./query.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createVault } = createMemoryWikiTestHarness();

afterEach(() => {
  vi.restoreAllMocks();
});

// A vault without a digest whose whole-vault scan takes hundreds of milliseconds, long
// enough for a read issued during the scan to be observed against it.
async function createScanVault() {
  const vault = await createVault({
    initialize: true,
    config: { search: { backend: "local", corpus: "wiki" } },
  });
  const groups = ["sources", "entities", "concepts", "syntheses"] as const;
  const pageTypes = {
    sources: "source",
    entities: "entity",
    concepts: "concept",
    syntheses: "synthesis",
  };
  for (let index = 0; index < 400; index += 1) {
    const group = groups[index % groups.length]!;
    const lines = Array.from(
      { length: 150 },
      (_, line) =>
        `cobalt lantern ledger line ${line} of page ${index} harbor quarry meridian saffron tundra velvet.`,
    );
    await fs.writeFile(
      path.join(vault.rootDir, group, `page-${index}.md`),
      renderWikiMarkdown({
        frontmatter: {
          pageType: pageTypes[group],
          id: `${group.slice(0, -1)}.page-${index}`,
          title: `Lantern page ${index}`,
          claims: [
            { id: `claim.page-${index}`, text: `Cobalt note ${index}.`, status: "supported" },
          ],
        },
        body: `# Lantern page ${index}\n\n${lines.join("\n")}\n`,
      }),
    );
  }
  return vault;
}

const scanTask = (rootDir: string) => ({
  rootDir,
  visibility: null,
  select: "search" as const,
  query: "cobalt lantern ledger",
  mode: "auto" as const,
  maxResults: 5,
});

describe("memory wiki query scheduling", () => {
  it("serves an exact-path read on the calling thread while a whole-vault scan runs in the pool", async () => {
    const { config } = await createScanVault();
    const dispatch = vi.spyOn(queryReader, "readMemoryWikiPages");
    let scanSettled = false;
    const scanStart = performance.now();
    const scan = searchMemoryWiki({
      config,
      query: "cobalt lantern ledger",
      maxResults: 5,
    }).finally(() => {
      scanSettled = true;
    });
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));

    const readStart = performance.now();
    const page = await getMemoryWikiPage({ config, lookup: "sources/page-4.md", lineCount: 1 });
    const readMs = performance.now() - readStart;
    const settledBeforeScan = !scanSettled;
    const results = await scan;
    const scanMs = performance.now() - scanStart;

    expect(page?.path).toBe("sources/page-4.md");
    expect(results.length).toBeGreaterThan(0);
    // The read finished while the scan was still running and never touched the pool.
    expect(settledBeforeScan).toBe(true);
    expect(dispatch.mock.calls.map(([task]) => task.select)).toEqual(["search"]);
    expect(readMs * 5).toBeLessThan(scanMs);
  });

  it("rejects a scan that exceeds the task bound with the deadline error and keeps serving scans", async () => {
    const { rootDir } = await createScanVault();

    await expect(readMemoryWikiPages(scanTask(rootDir), { timeoutMs: 10 })).rejects.toThrow(
      "wiki_search timed out after 0.01s",
    );
    const served = await readMemoryWikiPages(scanTask(rootDir));

    expect(served.results.length).toBeGreaterThan(0);
  });

  it("runs two whole-vault scans in parallel on two workers and queues a third", async () => {
    const { rootDir } = await createScanVault();
    await closeMemoryWikiQueryReader();
    let workersCreated = 0;
    const onWorker = () => {
      workersCreated += 1;
    };
    process.on("worker", onWorker);
    try {
      const settledOrder: number[] = [];
      const scans = [0, 1, 2].map((index) =>
        readMemoryWikiPages(scanTask(rootDir)).then((result) => {
          settledOrder.push(index);
          return result;
        }),
      );
      const results = await Promise.all(scans);

      expect(workersCreated).toBe(2);
      // The third scan waited for a worker and settled after both that ran first.
      expect(settledOrder[2]).toBe(2);
      for (const result of results) {
        expect(JSON.stringify(result.results)).toBe(JSON.stringify(results[0]?.results));
      }
      expect(results[0]?.results.length).toBeGreaterThan(0);
    } finally {
      process.off("worker", onWorker);
    }
  });
});
