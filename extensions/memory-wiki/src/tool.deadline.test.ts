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
  // Only one-shot callers await maintenance; a running service refreshes after the search.
  const causes =
    phase === "maintenance"
      ? (["deadline", "caller"] as const)
      : (["deadline", "caller", "service", "outside-service"] as const);
  for (const cause of causes) {
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
    const context =
      phase === "maintenance" || cause === "outside-service"
        ? {}
        : { signal: service.signal, refreshSources: vi.fn() };
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
    expect(signal?.aborted).toBe(true);
    finish.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(completed).toBe(false);
  }
});

it("answers from the current index while the service refreshes", async () => {
  vi.useFakeTimers();
  const hit = { corpus: "wiki", kind: "entity", title: "Alpha", path: "a.md", snippet: "alpha" };
  const refreshSources = vi.fn();
  work.sync.mockReturnValue(new Promise(() => {}));
  work.query.mockImplementation(async () => {
    expect(refreshSources).not.toHaveBeenCalled();
    return [hit];
  });
  const tool = createWikiSearchTool({} as ResolvedMemoryWikiConfig, undefined, {
    signal: new AbortController().signal,
    refreshSources,
  });
  const result = tool.execute("search", { query: "alpha" }).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(await result).toMatchObject({ details: { results: [hit] } });
  expect(refreshSources).toHaveBeenCalledOnce();
});
