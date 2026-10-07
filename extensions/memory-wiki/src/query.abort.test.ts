import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as markdown from "./markdown.js";
import { readWikiPagesTask } from "./query-pages.js";
import * as queryReader from "./query-reader.js";
import { searchMemoryWiki } from "./query.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

vi.mock("./markdown.js", { spy: true });
const harness = createMemoryWikiTestHarness();
afterEach(() => vi.restoreAllMocks());

async function createArchiveVault() {
  const vault = await harness.createVault({ initialize: true });
  await Promise.all(
    Array.from({ length: 32 }, (_, index) =>
      fs.writeFile(
        path.join(vault.rootDir, "entities", `page-${index}.md`),
        `---\npageType: entity\nid: page.${index}\ntitle: Archive ${index}\n---\nArchival text.\n`,
      ),
    ),
  );
  return vault;
}

// The reader runs in the worker, so the parse spy and the mid-scan abort are
// exercised on the reader itself; the pool-level abort is covered below.
it("stops parsing vault pages after cancellation during a scan", async () => {
  const { rootDir } = await createArchiveVault();
  const controller = new AbortController();
  const { scanWikiPageSummary: original } = await vi.importActual<typeof markdown>("./markdown.js");
  const scan = vi.spyOn(markdown, "scanWikiPageSummary").mockImplementation((params) => {
    const page = original(params);
    controller.abort(new Error("Turn cancelled"));
    return page;
  });
  await expect(
    readWikiPagesTask(
      {
        rootDir,
        visibility: null,
        select: "search",
        query: "absent multi term",
        mode: "auto",
        maxResults: 10,
      },
      controller.signal,
    ),
  ).rejects.toThrow("Turn cancelled");
  expect(scan).toHaveBeenCalledTimes(1);
});

it("rejects a whole-vault search through the pool's cancellation of its dispatched task", async () => {
  const { config } = await createArchiveVault();
  const controller = new AbortController();
  const reason = new Error("Turn cancelled");
  const dispatched = queryReader.readMemoryWikiPages;
  let pending: Promise<unknown> | undefined;
  // Abort only once the search has handed its whole-vault task to the pool. The pool
  // has not served a task yet in this file, so the task is queued while its worker
  // starts; the rejection must come from that queued task, not from a host check.
  const read = vi.spyOn(queryReader, "readMemoryWikiPages").mockImplementation((task, options) => {
    pending = dispatched(task, options);
    controller.abort(reason);
    return pending;
  });

  await expect(
    searchMemoryWiki({ config, query: "absent multi term", signal: controller.signal }),
  ).rejects.toBe(reason);
  expect(read).toHaveBeenCalledOnce();
  expect(read.mock.calls[0]?.[0].select).toBe("search");
  expect(read.mock.calls[0]?.[0].relativePaths).toBeUndefined();
  expect(read.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  await expect(pending).rejects.toBe(reason);
});
