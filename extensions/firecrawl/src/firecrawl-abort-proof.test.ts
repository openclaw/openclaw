// Firecrawl abort-signal proof: exercises the real Firecrawl client →
// postFirecrawlJson → withStrictWebToolsEndpoint → guarded fetch chain
// with only globalThis.fetch replaced, so the full guarded-fetch stack
// runs end-to-end.
import { describe, expect, it, vi } from "vitest";

describe("firecrawl abort signal proof", () => {
  const priorFetch = globalThis.fetch;
  const priorApiKey = process.env.FIRECRAWL_API_KEY;

  it("forwards the execution abort signal through guarded fetch to the HTTP request", async () => {
    // Firecrawl client checks for an API key; supply one so the code reaches fetch.
    process.env.FIRECRAWL_API_KEY = "test-proof-key";

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
      // Import the real (unmocked) Firecrawl client directly so the full
      // production chain runs: runFirecrawlSearch → postFirecrawlJson →
      // withStrictWebToolsEndpoint → guarded fetch → fetch.
      const { runFirecrawlSearch } = await import("./firecrawl-client.js");
      const executePromise = runFirecrawlSearch({
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
      process.env.FIRECRAWL_API_KEY = priorApiKey;
    }
  });
});
