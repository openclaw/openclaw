import fs from "node:fs/promises";
import path from "node:path";
import { WorkerTaskPool } from "openclaw/plugin-sdk/process-runtime";
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

// A small vault without a digest, so every search is a whole-vault scan task.
async function createScanVault() {
  const vault = await createVault({
    initialize: true,
    config: { search: { backend: "local", corpus: "wiki" } },
  });
  for (let index = 0; index < 8; index += 1) {
    await fs.writeFile(
      path.join(vault.rootDir, "sources", `page-${index}.md`),
      renderWikiMarkdown({
        frontmatter: { pageType: "source", id: `source.page-${index}`, title: `Lantern ${index}` },
        body: `# Lantern ${index}\n\ncobalt lantern ledger note ${index}.\n`,
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
  it("serves an exact-path read without the pool while a whole-vault search scan is held", async () => {
    const { config } = await createScanVault();
    const dispatchScan = queryReader.readMemoryWikiPages;
    const { promise: held, resolve: hold } = Promise.withResolvers<void>();
    const { promise: released, resolve: release } = Promise.withResolvers<void>();
    // Hold every search scan before it reaches the pool; other tasks pass through, so a
    // read that still went through the pool would show up in the dispatch log.
    const dispatch = vi
      .spyOn(queryReader, "readMemoryWikiPages")
      .mockImplementation(async (task, options) => {
        if (task.select === "search") {
          hold();
          await released;
        }
        return dispatchScan(task, options);
      });
    let scanSettled = false;
    const scan = searchMemoryWiki({
      config,
      query: "cobalt lantern ledger",
      maxResults: 5,
    }).finally(() => {
      scanSettled = true;
    });
    await held;

    const page = await getMemoryWikiPage({ config, lookup: "sources/page-4.md", lineCount: 1 });

    expect(page?.path).toBe("sources/page-4.md");
    expect(scanSettled).toBe(false);
    expect(dispatch.mock.calls.map(([task]) => task.select)).toEqual(["search"]);
    release();
    expect((await scan).length).toBeGreaterThan(0);
  });

  it("leaves an unsignalled scan unbounded, as on main, and passes a caller signal through", async () => {
    const { rootDir } = await createScanVault();
    const run = vi.spyOn(WorkerTaskPool.prototype, "run");
    const controller = new AbortController();

    await readMemoryWikiPages(scanTask(rootDir));
    await readMemoryWikiPages(scanTask(rootDir), { signal: controller.signal });

    expect(run.mock.calls.map(([, options]) => options.timeoutMs)).toEqual([undefined, undefined]);
    expect(run.mock.calls.map(([, options]) => options.signal)).toEqual([
      undefined,
      controller.signal,
    ]);
  });

  it("admits at most two scans at once and queues the rest", async () => {
    const { rootDir } = await createScanVault();
    await closeMemoryWikiQueryReader();
    const run = vi.spyOn(WorkerTaskPool.prototype, "run");

    // Admission and dispatch happen synchronously inside run(), so the snapshot taken
    // right after the third submission is the pool's state before any scan can settle.
    const scans = [0, 1, 2].map(() => readMemoryWikiPages(scanTask(rootDir)));
    const pool = run.mock.contexts[0] as WorkerTaskPool<unknown, unknown>;
    const admitted = pool.getSnapshot();
    const results = await Promise.all(scans);
    const settled = pool.getSnapshot();

    expect(new Set(run.mock.contexts).size).toBe(1);
    expect(admitted.maxWorkers).toBe(2);
    expect(admitted.pendingTasks).toBe(3);
    // Shared compute can admit fewer than two on a small host; never more.
    expect(admitted.activeTasks).toBeGreaterThanOrEqual(1);
    expect(admitted.activeTasks).toBeLessThanOrEqual(2);
    expect(settled.workersCreated).toBeLessThanOrEqual(2);
    expect(settled).toMatchObject({ activeTasks: 0, pendingTasks: 0 });
    for (const result of results) {
      expect(JSON.stringify(result.results)).toBe(JSON.stringify(results[0]?.results));
    }
    expect(results[0]?.results.length).toBeGreaterThan(0);
  });
});
