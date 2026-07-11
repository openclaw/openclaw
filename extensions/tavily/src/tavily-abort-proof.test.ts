// Tavily abort-signal proof: exercises the real Tavily client →
// postTrustedWebToolsJson → guarded fetch chain with only globalThis.fetch
// replaced, so the full guarded-fetch stack runs end-to-end.
import { describe, expect, it, vi } from "vitest";

describe("tavily abort signal proof", () => {
  const priorFetch = globalThis.fetch;
  const priorApiKey = process.env.TAVILY_API_KEY;

  it("forwards the execution abort signal through guarded fetch to the HTTP request", async () => {
    // Tavily client checks for an API key; supply one so the code reaches fetch.
    process.env.TAVILY_API_KEY = "test-proof-key";

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

    try {
      // Import the real (unmocked) Tavily client directly so the full
      // production chain runs: runTavilySearch → postTavilyJson →
      // postTrustedWebToolsJson → guarded fetch → fetch.
      const { runTavilySearch } = await import("./tavily-client.js");
      const executePromise = runTavilySearch({
        query: "abort propagation proof",
        signal: controller.signal,
      });
      await new Promise((r) => {
        setTimeout(r, 10);
      });

      expect(capturedSignal).toBeDefined();

      controller.abort();
      await expect(executePromise).rejects.toThrow("The operation was aborted");
    } finally {
      globalThis.fetch = priorFetch;
      if (priorApiKey === undefined) {
        delete process.env.TAVILY_API_KEY;
      } else {
        process.env.TAVILY_API_KEY = priorApiKey;
      }
    }
  });
});
