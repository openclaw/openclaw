/**
 * Real behavior proof: Tavily abort signal through the guarded-fetch stack.
 *
 * Tavily production code path:
 *   runTavilySearch (tavily-client.ts)
 *   → postTavilyJson({ signal }) → postTrustedWebToolsJson({ signal })
 *   → withTrustedWebToolsEndpoint({ signal }) (web-guarded-fetch.ts:82)
 *   → withWebToolsNetworkGuard({ useEnvProxy: true })
 *   → fetchWithSsrFGuard({ signal }) (fetch-guard.ts:460)
 *   → buildTimeoutAbortSignal({ signal }) (fetch-guard.ts:496)
 *   → fetch()
 *
 * This proof uses withSelfHostedWebToolsEndpoint — the localhost-allowed
 * sibling of withTrustedWebToolsEndpoint. Both share identical
 * fetchWithSsrFGuard → buildTimeoutAbortSignal → fetch() code paths;
 * only the SSRF policy object differs.
 *
 * A stalled HTTP server (never sends headers) simulates a remote endpoint
 * that accepts the TCP connection but withholds response headers forever.
 * The AbortController aborts after 100ms. If signal forwarding works,
 * the fetch rejects instead of hanging.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";

describe("tavily abort signal proof", () => {
  it("propagates abort signal through the guarded-fetch stack used by Tavily", async () => {
    const { withSelfHostedWebToolsEndpoint } = await vi.importActual<
      typeof import("openclaw/plugin-sdk/provider-web-search")
    >("openclaw/plugin-sdk/provider-web-search");

    // Create a stalled server — never calls res.writeHead().
    const server = createServer((_req, res) => {
      res.socket?.setTimeout(0);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    const controller = new AbortController();
    const startedAt = Date.now();

    const searchPromise = withSelfHostedWebToolsEndpoint(
      {
        url: `http://127.0.0.1:${port}/stall`,
        timeoutSeconds: 30,
        init: { method: "GET" },
        signal: controller.signal,
      },
      async (_result) => ({ ok: true }),
    );

    // Abort after 100ms.
    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort("proof: cancellation");

    await expect(searchPromise).rejects.toThrow();
    const elapsed = Date.now() - startedAt;

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
        `(withSelfHostedWebToolsEndpoint → fetchWithSsrFGuard → buildTimeoutAbortSignal → fetch)`,
    );
    console.log(`[proof] stalled server: http://127.0.0.1:${port}/stall`);
    console.log(`[proof] abort: controller.abort("proof: cancellation") @ ~100ms`);
    console.log(`[proof] error: ${errorType}: ${errorMessage}`);

    server.close();
    expect(elapsed).toBeLessThan(5000);
  }, 15000);
});
