// DuckDuckGo abort-signal proof: exercises the real DDG client →
// withTrustedWebSearchEndpoint → fetch chain with only globalThis.fetch
// replaced, so the full guarded-fetch stack runs end-to-end.
import { describe, expect, it, vi } from "vitest";

describe("duckduckgo abort signal proof", () => {
  const priorFetch = globalThis.fetch;

  it("forwards the execution abort signal through guarded fetch to the HTTP request", async () => {
    const controller = new AbortController();
    let capturedSignal: AbortSignal | null | undefined;

    let resolveOnFetch: () => void;
    const fetchWasCalled = new Promise<void>((r) => {
      resolveOnFetch = r;
    });
    const mockFetch = vi.fn(async (_input?: unknown, init?: unknown) => {
      capturedSignal = (init as RequestInit)?.signal ?? undefined;
      resolveOnFetch();
      return new Promise<Response>((_resolve, reject) => {
        capturedSignal?.addEventListener(
          "abort",
          () => reject(new DOMException("The operation was aborted", "AbortError")),
          { once: true },
        );
      });
    });
    globalThis.fetch = mockFetch as typeof globalThis.fetch;

    try {
      // Import the real (unmocked) DDG client directly so the full
      // production chain runs: runDuckDuckGoSearch →
      // withTrustedWebSearchEndpoint → fetchWithSsrFGuard → fetch.
      const { runDuckDuckGoSearch } = await import("./ddg-client.js");
      const executePromise = runDuckDuckGoSearch({
        query: "abort propagation",
        signal: controller.signal,
      });
      await fetchWasCalled;

      expect(capturedSignal).toBeDefined();

      controller.abort();
      await expect(executePromise).rejects.toThrow("The operation was aborted");
    } finally {
      globalThis.fetch = priorFetch;
    }
  });
});
