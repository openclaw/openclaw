// Perplexity abort-signal proof: exercises the real Perplexity search
// client → withTrustedWebSearchEndpoint → guarded fetch chain with
// only globalThis.fetch replaced, so the full guarded-fetch stack
// runs end-to-end.
import { describe, expect, it, vi } from "vitest";

describe("perplexity abort signal proof", () => {
  const priorFetch = globalThis.fetch;

  it("forwards the execution abort signal through guarded fetch to the HTTP request", async () => {
    vi.stubEnv("PERPLEXITY_API_KEY", "test-proof-key");

    const controller = new AbortController();
    let capturedSignal: AbortSignal | null | undefined;

    const mockFetch = vi.fn(async (_input?: unknown, init?: unknown) => {
      capturedSignal = (init as RequestInit)?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        capturedSignal?.addEventListener(
          "abort",
          () => reject(new DOMException("The operation was aborted", "AbortError")),
          { once: true },
        );
      });
    });
    globalThis.fetch = mockFetch as typeof globalThis.fetch;
    global.fetch = mockFetch as typeof global.fetch;

    try {
      // Import the real (unmocked) Perplexity client directly so the full
      // production chain runs: executePerplexitySearch →
      // withTrustedWebSearchEndpoint → guarded fetch → fetch.
      const { executePerplexitySearch } =
        await import("./perplexity-web-search-provider.runtime.js");
      const executePromise = executePerplexitySearch(
        { query: "abort propagation proof" },
        undefined,
        controller.signal,
      );
      await new Promise((r) => {
        setTimeout(r, 10);
      });

      expect(capturedSignal).toBeDefined();

      controller.abort();
      await expect(executePromise).rejects.toThrow("The operation was aborted");
    } finally {
      globalThis.fetch = priorFetch;
      global.fetch = priorFetch;
    }
  });
});
