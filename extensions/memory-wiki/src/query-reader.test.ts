import fs from "node:fs/promises";
import path from "node:path";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compileMemoryWikiVault } from "./compile.js";
import * as wikiLinks from "./markdown-links.js";
import { renderWikiMarkdown } from "./markdown.js";
import { readWikiPagesTask } from "./query-pages.js";
import * as queryReader from "./query-reader.js";
import { closeMemoryWikiQueryReader, readMemoryWikiPages } from "./query-reader.js";
import { sortWikiSearchResults } from "./query-scoring.js";
import { getMemoryWikiPage, searchMemoryWiki, type WikiSearchMode } from "./query.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createVault } = createMemoryWikiTestHarness();

afterEach(() => {
  __setFsSafeTestHooksForTest(undefined);
  vi.restoreAllMocks();
});

async function createScoringVault() {
  const vault = await createVault({
    initialize: true,
    config: { search: { backend: "local", corpus: "wiki" } },
  });
  const write = (relativePath: string, markdown: Parameters<typeof renderWikiMarkdown>[0]) =>
    fs.writeFile(path.join(vault.rootDir, relativePath), renderWikiMarkdown(markdown));
  await fs.mkdir(path.join(vault.rootDir, "sources", "nested"), { recursive: true });
  for (let index = 0; index < 12; index += 1) {
    await write(`sources/page-${index}.md`, {
      frontmatter: {
        pageType: "source",
        id: `source.page-${index}`,
        title: `Harbor ledger ${index}`,
        sourceIds: [`source.page-${(index + 1) % 12}`],
        aliases: index === 7 ? ["keeps watch"] : index % 3 === 0 ? ["lantern keeper"] : [],
        updatedAt: `2026-0${(index % 9) + 1}-01T00:00:00.000Z`,
        claims: [
          {
            id: `claim.page-${index}.a`,
            text: `Lantern ledger entry ${index} records the harbor tally.`,
            status: index % 4 === 0 ? "contested" : "supported",
            confidence: (index % 10) / 10,
            evidence: [{ kind: "source", sourceId: `source.page-${index}`, note: "tally" }],
          },
          { id: `claim.page-${index}.b`, text: `Cobalt note ${index}.`, status: "supported" },
        ],
      },
      body: `# Harbor ledger ${index}\n\nLantern ledger body ${index} ${"cobalt ".repeat(index)}\n<!-- openclaw:wiki:related:start -->\nrelated lantern\n<!-- openclaw:wiki:related:end -->\n`,
    });
  }
  await write("entities/keeper.md", {
    frontmatter: {
      pageType: "entity",
      entityType: "person",
      id: "entity.keeper",
      title: "Lantern Keeper",
      canonicalId: "keeper",
      aliases: ["the keeper"],
      personCard: { canonicalId: "keeper", lane: "harbor operations", askFor: ["ledger audits"] },
      relationships: [{ kind: "works-with", targetId: "entity.mate", targetTitle: "First Mate" }],
    },
    body: "# Lantern Keeper\n\nKeeps the harbor ledger.\n[[sources/page-1]]\n",
  });
  await write("sources/nested/bridge-note.md", {
    frontmatter: {
      pageType: "source",
      id: "source.bridge-note",
      title: "Bridge Lantern Note",
      sourceType: "memory-bridge",
      sourcePath: "/tmp/workspace/bridge-note.md",
      bridgeRelativePath: "bridge-note.md",
      bridgeWorkspaceDir: "/tmp/workspace",
      bridgeAgentIds: ["Main"],
    },
    body: "# Bridge Lantern Note\n\nlantern ledger from the bridge\n",
  });
  await write("concepts/non-ascii.md", {
    frontmatter: { pageType: "concept", id: "concept.lanterne", title: "Lanterne du port" },
    body: "# Lanterne du port\n\nregistre de lanterne harbor ledger\n",
  });
  await fs.writeFile(path.join(vault.rootDir, "sources", "broken.md"), "---\ninvalid: [\n---\n");
  return vault;
}

const SEARCHES: Array<{ query: string; mode: WikiSearchMode; maxResults: number }> = [
  { query: "lantern ledger", mode: "auto", maxResults: 5 },
  { query: "harbor", mode: "raw-claim", maxResults: 3 },
  { query: "who knows about ledger audits", mode: "route-question", maxResults: 4 },
  { query: "keeper", mode: "find-person", maxResults: 2 },
  { query: "source.page-3", mode: "source-evidence", maxResults: 3 },
  { query: "lanterne", mode: "auto", maxResults: 10 },
];

describe("memory wiki query reader", () => {
  it.each([false, true])(
    "returns the same results through the worker as an in-thread whole-vault read (compiled=%s)",
    async (compiled) => {
      const { rootDir, config } = await createScoringVault();
      if (compiled) {
        await compileMemoryWikiVault(config);
      }
      for (const search of SEARCHES) {
        const reference = sortWikiSearchResults(
          (
            await readWikiPagesTask({
              rootDir,
              visibility: null,
              select: "search",
              query: search.query,
              mode: search.mode,
              maxResults: Number.MAX_SAFE_INTEGER,
            })
          ).results,
        ).slice(0, search.maxResults);
        expect(reference.length).toBeGreaterThan(0);

        const results = await searchMemoryWiki({ config, ...search });

        expect(JSON.stringify(results)).toBe(JSON.stringify(reference));
      }
      for (const lookup of ["sources/page-4.md", "page-4", "source.page-4", "entity.keeper"]) {
        const reference = (
          await readWikiPagesTask({ rootDir, visibility: null, select: "lookup", lookup })
        ).page;
        const result = await getMemoryWikiPage({ config, lookup, lineCount: 5 });
        expect(result?.path).toBe(reference?.relativePath);
        expect(result?.content).toBe(reference?.parsed.body.split(/\r?\n/).slice(0, 5).join("\n"));
      }
    },
  );

  it("backfills underfilled digest candidates from the rest of the vault", async () => {
    const { config } = await createScoringVault();
    await compileMemoryWikiVault(config);
    const dispatch = vi.spyOn(queryReader, "readMemoryWikiPages");

    // "keeps watch" is a digest alias of page 7, so it is the only candidate; the keeper
    // page says "Keeps the harbor ledger." only in its body, outside the digest.
    const results = await searchMemoryWiki({ config, query: "keeps", maxResults: 10 });

    const tasks = dispatch.mock.calls.map(([task]) => task);
    expect(tasks.map((task) => [task.select, task.relativePaths, task.excludePaths])).toEqual([
      ["search", ["sources/page-7.md"], undefined],
      ["search", undefined, ["sources/page-7.md"]],
    ]);
    expect(
      results
        .map((result) => result.path ?? "")
        .toSorted((left, right) => left.localeCompare(right)),
    ).toEqual(["entities/keeper.md", "sources/page-7.md"]);
    expect(results.map((result) => result.score)).toEqual(
      results.map((result) => result.score).toSorted((left, right) => right - left),
    );
  });

  it("reads only compiled metadata candidates for distributed query tokens", async () => {
    const { rootDir, config } = await createScoringVault();
    const relativePath = "sources/quartz.md";
    await fs.writeFile(
      path.join(rootDir, relativePath),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "source",
          id: "source.quartz",
          title: "Cobalt",
          aliases: ["amber"],
          questions: ["lantern"],
        },
        body: "# Cobalt\n\nSelected evidence.\n",
      }),
    );
    const query = "cobalt quartz amber lantern";
    const liveResults = await searchMemoryWiki({ config, query, maxResults: 1 });
    expect(liveResults[0]?.path).toBe(relativePath);
    await compileMemoryWikiVault(config);
    const dispatch = vi.spyOn(queryReader, "readMemoryWikiPages");

    await expect(searchMemoryWiki({ config, query, maxResults: 1 })).resolves.toEqual(liveResults);

    // The digest admits the page on distributed tokens, so the only read is the
    // candidate read for that page; no whole-vault task follows.
    expect(dispatch.mock.calls.map(([task]) => [task.select, task.relativePaths])).toEqual([
      ["search", [relativePath]],
    ]);
  });

  it("dispatches exact reads as single-page tasks and basename reads as whole-vault lookups", async () => {
    const { config } = await createScoringVault();
    const dispatch = vi.spyOn(queryReader, "readMemoryWikiPages");

    await getMemoryWikiPage({ config, lookup: "sources/page-1.md" });
    const exact = dispatch.mock.calls.map(([task]) => [task.select, task.relativePaths]);
    dispatch.mockClear();
    await getMemoryWikiPage({ config, lookup: "page-1" });
    const basename = dispatch.mock.calls.map(([task]) => [task.select, task.relativePaths]);

    expect(exact).toEqual([["page", ["sources/page-1.md"]]]);
    expect(basename).toEqual([["lookup", undefined]]);
  });

  it("reads query pages without extracting the link graph", async () => {
    const { rootDir } = await createScoringVault();
    const extractLinks = vi.spyOn(wikiLinks, "extractWikiLinks");

    const search = await readWikiPagesTask({
      rootDir,
      visibility: null,
      select: "search",
      query: "keeps the harbor ledger",
      mode: "auto",
      maxResults: 5,
    });
    const lookup = await readWikiPagesTask({
      rootDir,
      visibility: null,
      select: "lookup",
      lookup: "keeper",
    });

    expect(search.results.map((result) => result.path)).toContain("entities/keeper.md");
    expect(lookup.page?.relativePath).toBe("entities/keeper.md");
    expect(extractLinks).not.toHaveBeenCalled();
  });

  it("applies the serialized sandbox scope inside the worker", async () => {
    const { config } = await createScoringVault();
    const scoped = await searchMemoryWiki({
      config,
      agentId: "secondary",
      sandboxed: true,
      query: "lantern ledger from the bridge",
    });
    const owner = await searchMemoryWiki({
      config,
      agentId: "main",
      sandboxed: true,
      query: "lantern ledger from the bridge",
    });

    expect(scoped.map((result) => result.path)).not.toContain("sources/nested/bridge-note.md");
    expect(owner.map((result) => result.path)).toContain("sources/nested/bridge-note.md");
  });

  it("rejects a page swapped outside the vault between listing and reading", async () => {
    const { rootDir } = await createScoringVault();
    const targetPath = path.join(rootDir, "sources", "page-1.md");
    const outside = await createScoringVault();
    const canonicalTarget = await fs.realpath(targetPath);
    let swapped = false;
    __setFsSafeTestHooksForTest({
      beforeOpen: async (filePath) => {
        if (swapped || path.resolve(filePath) !== canonicalTarget) {
          return;
        }
        swapped = true;
        await fs.unlink(targetPath);
        await fs.symlink(path.join(outside.rootDir, "sources", "page-1.md"), targetPath);
      },
    });

    await expect(
      readWikiPagesTask({ rootDir, visibility: null, select: "lookup", lookup: "page-1" }),
    ).rejects.toMatchObject({
      name: "FsSafeError",
      code: expect.stringMatching(/symlink|path-mismatch/u),
    });
    expect(swapped).toBe(true);
  });

  it("rebuilds a worker boundary refusal as the same error on the host", async () => {
    const { rootDir } = await createScoringVault();
    const targetPath = path.join(rootDir, "sources", "page-2.md");
    const outside = await createScoringVault();
    await fs.unlink(targetPath);
    await fs.symlink(path.join(outside.rootDir, "sources", "page-2.md"), targetPath);

    await expect(
      readMemoryWikiPages({
        rootDir,
        relativePaths: ["sources/page-2.md"],
        visibility: null,
        select: "page",
      }),
    ).rejects.toMatchObject({
      name: "FsSafeError",
      code: expect.stringMatching(/symlink|path-mismatch/u),
    });
  });

  it("rejects a read whose signal is already aborted without dispatching it", async () => {
    const { rootDir } = await createScoringVault();
    // Start from no pool: a dispatched task would have to create the worker first.
    await closeMemoryWikiQueryReader();
    let workersCreated = 0;
    const onWorker = () => {
      workersCreated += 1;
    };
    process.on("worker", onWorker);
    try {
      const controller = new AbortController();
      const reason = new Error("caller cancelled the wiki read");
      controller.abort(reason);

      await expect(
        readMemoryWikiPages(
          { rootDir, visibility: null, select: "lookup", lookup: "page-1" },
          { signal: controller.signal },
        ),
      ).rejects.toBe(reason);
      expect(workersCreated).toBe(0);
    } finally {
      process.off("worker", onWorker);
    }
  });

  // With one worker, a task handed to an idle, ready worker is sent to it before
  // run() returns (WorkerTaskPoolCore.run dispatches synchronously), and any task
  // submitted while that one is in flight waits in the pool's queue.
  it("rejects a read queued behind a running scan and lets the scan finish", async () => {
    const { rootDir } = await createScoringVault();
    const warm = await readMemoryWikiPages({
      rootDir,
      visibility: null,
      select: "lookup",
      lookup: "page-3",
    });
    expect(warm.page?.relativePath).toBe("sources/page-3.md");
    const scan = readMemoryWikiPages({
      rootDir,
      visibility: null,
      select: "search",
      query: "lantern ledger",
      mode: "auto",
      maxResults: 5,
    });
    const controller = new AbortController();
    const reason = new Error("caller cancelled the queued wiki read");
    const queued = readMemoryWikiPages(
      { rootDir, visibility: null, select: "lookup", lookup: "page-3" },
      { signal: controller.signal },
    );
    controller.abort(reason);

    await expect(queued).rejects.toBe(reason);
    const finished = await scan;
    expect(finished.results).toHaveLength(5);
    expect(finished.results.every((result) => result.score > 0)).toBe(true);
  });

  it("recovers on a fresh worker after a running read is cancelled", async () => {
    const { rootDir } = await createScoringVault();
    // Node announces every Worker the process creates; a retired worker is replaced.
    let workersCreated = 0;
    const onWorker = () => {
      workersCreated += 1;
    };
    process.on("worker", onWorker);
    try {
      const warm = await readMemoryWikiPages({
        rootDir,
        visibility: null,
        select: "lookup",
        lookup: "page-3",
      });
      expect(warm.page?.relativePath).toBe("sources/page-3.md");
      const controller = new AbortController();
      const reason = new Error("caller cancelled the running wiki read");
      // The worker is idle and ready, so this task is in flight when abort() runs.
      const running = readMemoryWikiPages(
        { rootDir, visibility: null, select: "lookup", lookup: "page-3" },
        { signal: controller.signal },
      );
      controller.abort(reason);

      await expect(running).rejects.toBe(reason);
      const workersBeforeRecovery = workersCreated;
      const recovered = await readMemoryWikiPages({
        rootDir,
        visibility: null,
        select: "lookup",
        lookup: "page-3",
      });
      expect(recovered.page?.relativePath).toBe("sources/page-3.md");
      expect(workersCreated).toBe(workersBeforeRecovery + 1);
    } finally {
      process.off("worker", onWorker);
    }
  });

  it("recreates the reader after the plugin closes it", async () => {
    const { rootDir } = await createScoringVault();
    const before = await readMemoryWikiPages({
      rootDir,
      visibility: null,
      select: "lookup",
      lookup: "page-5",
    });
    await closeMemoryWikiQueryReader();
    const after = await readMemoryWikiPages({
      rootDir,
      visibility: null,
      select: "lookup",
      lookup: "page-5",
    });

    expect(before.page?.relativePath).toBe("sources/page-5.md");
    expect(after.page?.relativePath).toBe("sources/page-5.md");
  });
});
