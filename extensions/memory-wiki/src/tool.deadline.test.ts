import { afterEach, expect, it, vi } from "vitest";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import type * as QueryModule from "./query.js";
import type * as SourceSyncModule from "./source-sync.js";
import { createWikiSearchTool } from "./tool.js";

const work = vi.hoisted(() => ({ sync: vi.fn(), query: vi.fn() }));
vi.mock("./source-sync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof SourceSyncModule>()),
  syncMemoryWikiImportedSources: work.sync,
}));
vi.mock("./query.js", async (importOriginal) => ({
  ...(await importOriginal<typeof QueryModule>()),
  searchMemoryWiki: work.query,
}));
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

it.each(["maintenance", "query"] as const)("owns %s cancellation", async (phase) => {
  for (const cause of ["deadline", "caller", "service", "outside-service"] as const) {
    vi.useFakeTimers();
    const caller = new AbortController();
    const service = new AbortController();
    const finish = Promise.withResolvers<void>();
    let completed = false;
    let signal: AbortSignal | undefined;
    const stalled = async (params: { signal: AbortSignal }) => {
      signal = params.signal;
      await finish.promise;
      signal.throwIfAborted();
      completed = true;
      return [];
    };
    work.sync.mockImplementation(phase === "maintenance" ? stalled : async () => {});
    work.query.mockImplementation(phase === "query" ? stalled : async () => []);
    const context = cause === "outside-service" ? {} : { signal: service.signal };
    const tool = createWikiSearchTool({} as ResolvedMemoryWikiConfig, undefined, context);
    const failure = tool
      .execute("search", { query: "project-alpha" }, caller.signal)
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    if (cause === "deadline") {
      await vi.advanceTimersByTimeAsync(30_000);
    } else {
      (cause === "service" ? service : caller).abort(new Error("cancelled"));
    }
    expect(await failure).toBeInstanceOf(Error);
    const survives = phase === "maintenance" && (cause === "deadline" || cause === "caller");
    expect(signal?.aborted).toBe(!survives);
    finish.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(completed).toBe(survives);
  }
});
