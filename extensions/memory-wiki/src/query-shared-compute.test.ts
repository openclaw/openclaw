import { WorkerTaskPool } from "openclaw/plugin-sdk/process-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WIKI_SCAN_YIELD } from "./query-pages.js";
import { readMemoryWikiPages } from "./query-reader.js";
import {
  createBatchedVault,
  scanTask,
  TIED_VAULT_PAGES,
  wholeVaultReference,
} from "./query-scan.test-support.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

// One shared compute permit, as on a one- or two-core host: max(1, cores - 1). The
// capacity is a process-wide singleton created on first use, so this file owns the pin.
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  availableParallelism: () => 2,
}));

const { createVault } = createMemoryWikiTestHarness();

afterEach(() => {
  vi.restoreAllMocks();
});

describe("memory wiki scans under shared compute contention", () => {
  it("yields a scan at its next checkpoint to a pool waiting for the only permit", async () => {
    const { rootDir } = await createBatchedVault(createVault, TIED_VAULT_PAGES);
    // Shaped like memory-core retrieval: one worker that takes shared compute. Its task
    // records admission while preparing its input and stops there, so no worker starts.
    const retrieval = new WorkerTaskPool<unknown, unknown>({
      workerUrl: new URL("data:text/javascript,"),
      maxWorkers: 1,
      sharedCompute: true,
    });
    const events: string[] = [];
    // oxlint-disable-next-line typescript/unbound-method -- Reflect.apply preserves the intercepted pool receiver.
    const dispatchRun = WorkerTaskPool.prototype.run;
    const run = vi.spyOn(WorkerTaskPool.prototype, "run");
    let retrievalRun: Promise<unknown> | undefined;
    run.mockImplementation(function (this: WorkerTaskPool<unknown, unknown>, input, options) {
      if (this === retrieval) {
        return Reflect.apply(dispatchRun, this, [input, options]);
      }
      const { select } = input as { select: string };
      events.push(`wiki ${select}`);
      const answer = options.onRequest;
      const observed = answer
        ? {
            ...options,
            onRequest: async (...request: Parameters<typeof answer>) => {
              const reply = await answer(...request);
              events.push(`checkpoint ${reply.input === WIKI_SCAN_YIELD ? "yield" : "continue"}`);
              return reply;
            },
          }
        : options;
      // Admission and dispatch are synchronous, so the scan task holds the only permit
      // when the retrieval task arrives.
      const running = Reflect.apply(dispatchRun, this, [input, observed]);
      if (select === "search" && !retrievalRun) {
        retrievalRun = retrieval.run(
          () => {
            events.push("retrieval admitted");
            throw new Error("retrieval admitted");
          },
          { inputBytes: 0 },
        );
        events.push("retrieval queued");
      }
      return running;
    });

    let scan: Awaited<ReturnType<typeof readMemoryWikiPages<ReturnType<typeof scanTask>>>>;
    try {
      scan = await readMemoryWikiPages(scanTask(rootDir));
      await expect(retrievalRun).rejects.toThrow("retrieval admitted");
    } finally {
      await retrieval.close();
    }

    // The first checkpoint yields; the retrieval task takes the permit before the host
    // resubmits the unread pages, and the resumed scan has nothing left to yield to.
    expect(events.slice(0, 6)).toEqual([
      "wiki list",
      "wiki search",
      "retrieval queued",
      "checkpoint yield",
      "retrieval admitted",
      "wiki search",
    ]);
    expect(new Set(events.slice(6))).toEqual(new Set(["checkpoint continue"]));
    expect(JSON.stringify(scan.results)).toBe(
      JSON.stringify(await wholeVaultReference(rootDir, scanTask(rootDir))),
    );
  });
});
