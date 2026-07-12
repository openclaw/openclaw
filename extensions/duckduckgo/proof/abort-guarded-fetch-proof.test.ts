/**
 * Real behavior proof: abort signal through the guarded-fetch stack.
 *
 * Exercises the EXACT code path that DuckDuckGo client calls:
 *   runDuckDuckGoSearch (ddg-client.ts)
 *   → withTrustedWebSearchEndpoint (web-search-provider-common.ts)
 *   → withTrustedWebToolsEndpoint (web-guarded-fetch.ts)
 *   → withWebToolsNetworkGuard → fetchWithWebToolsNetworkGuard
 *   → fetchWithSsrFGuard (fetch-guard.ts)
 *   → buildTimeoutAbortSignal → globalThis.fetch
 *
 * This proof uses withSelfHostedWebSearchEndpoint (same guarded-fetch stack,
 * same signal chain; the only difference is the SSRF policy — self-hosted
 * variant allows localhost so we can run a stalled server). Both variants
 * share identical fetchWithSsrFGuard → buildTimeoutAbortSignal → fetch()
 * code paths.
 *
 * A stalled HTTP server (never sends headers) simulates a remote endpoint
 * that accepts the TCP connection but withholds response headers forever.
 * The AbortController aborts after 100ms. If signal forwarding works,
 * the fetch rejects with AbortError / TimeoutError instead of hanging.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";

describe("ddg abort signal proof", () => {
  it("propagates abort signal through the guarded-fetch stack used by DDG", async () => {
    // Load the real guarded-fetch stack at the withSelfHostedWebSearchEndpoint
    // seam. This is the same code path DDG uses (same fetchWithSsrFGuard,
    // same buildTimeoutAbortSignal, same fetch). The only difference is
    // SSRF policy: self-hosted allows localhost for this proof.
    const { withSelfHostedWebSearchEndpoint } = await vi.importActual<
      typeof import("openclaw/plugin-sdk/provider-web-search")
    >("openclaw/plugin-sdk/provider-web-search");

    // Create a stalled server — never calls res.writeHead(), so the TCP
    // connection is accepted but fetch() never resolves.
    const server = createServer((_req, res) => {
      res.socket?.setTimeout(0);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    const controller = new AbortController();
    const startedAt = Date.now();

    const searchPromise = withSelfHostedWebSearchEndpoint(
      {
        url: `http://127.0.0.1:${port}/stall`,
        timeoutSeconds: 30,
        init: { method: "GET" },
        signal: controller.signal,
      },
      async (_result) => ({ ok: true }),
    );

    // Abort after 100ms — simulates user cancellation or timeout.
    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort("proof: cancellation");

    await expect(searchPromise).rejects.toThrow();
    const elapsed = Date.now() - startedAt;

    // Capture the exact error for the PR body.
    let errorType = "unknown";
    let errorMessage = "";
    try {
      await searchPromise;
    } catch (err) {
      errorType = err?.constructor?.name ?? "unknown";
      errorMessage = err instanceof Error ? err.message : String(err);
    }

    console.log(
      `[proof] Signal propagated in ${elapsed}ms through guarded-fetch stack ` +
        `(withSelfHostedWebSearchEndpoint → fetchWithSsrFGuard → buildTimeoutAbortSignal → fetch)`,
    );
    console.log(`[proof] stalled server: http://127.0.0.1:${port}/stall`);
    console.log(`[proof] abort: controller.abort("proof: cancellation") @ ~100ms`);
    console.log(`[proof] error: ${errorType}: ${errorMessage}`);

    server.close();
    expect(elapsed).toBeLessThan(5000);
  }, 15000);
});
