import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import type * as QueryModule from "./query.js";
import type * as SourceSyncModule from "./source-sync.js";
import { createWikiSearchTool } from "./tool.js";

const search = vi.hoisted(() => ({ signal: undefined as AbortSignal | undefined }));
vi.mock("./source-sync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof SourceSyncModule>()),
  syncMemoryWikiImportedSources: async () => {},
}));
vi.mock("./query.js", async (importOriginal) => ({
  ...(await importOriginal<typeof QueryModule>()),
  searchMemoryWiki: ({ signal }: { signal?: AbortSignal }) => {
    search.signal = signal;
    const { promise, reject } = Promise.withResolvers<never>();
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    return promise;
  },
}));

afterEach(() => {
  vi.useRealTimers();
  search.signal = undefined;
});

describe("wiki_search cancellation", () => {
  it.each(["deadline", "caller", "lifecycle"] as const)(
    "rejects stalled search and cancels its work on %s",
    async (cause) => {
      vi.useFakeTimers();
      const caller = new AbortController();
      const lifecycle = new AbortController();
      const tool = createWikiSearchTool({} as ResolvedMemoryWikiConfig, undefined, {
        signal: lifecycle.signal,
      });
      let failure: unknown;
      const result = tool.execute(
        "search",
        { query: "missing multi term", maxResults: 6 },
        caller.signal,
      );
      const settled = result.catch((error: unknown) => {
        failure = error;
      });
      await vi.advanceTimersByTimeAsync(0);
      if (cause === "deadline") {
        await vi.advanceTimersByTimeAsync(30_000);
      } else {
        (cause === "caller" ? caller : lifecycle).abort(new Error("Search cancelled"));
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe(
        cause === "deadline" ? "wiki_search timed out after 30s" : "Search cancelled",
      );
      expect(search.signal?.aborted).toBe(true);
      await settled;
    },
  );
});
