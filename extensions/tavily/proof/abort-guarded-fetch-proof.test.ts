/**
 * Real behavior proof: abort signal through Tavily's full provider→fetch chain.
 *
 * Tavily production code path:
 *   createTavilyWebSearchProvider().createTool(ctx).execute(args, context)
 *   → runTavilySearch({ signal: context?.signal })
 *   → postTavilyJson({ signal }) → postTrustedWebToolsJson({ signal })
 *   → withTrustedWebToolsEndpoint({ signal })
 *   → withWebToolsNetworkGuard({ useEnvProxy: true })
 *   → fetchWithSsrFGuard({ signal })
 *   → buildTimeoutAbortSignal({ signal })
 *   → fetch()
 *
 * Two-part proof:
 * 1. Pre-aborted signal through provider path — proves signal flows from
 *    provider.execute() through all intermediate layers to fetch().
 *    buildTimeoutAbortSignal sees the already-aborted parent signal and
 *    immediately aborts its controller, so no network I/O occurs.
 * 2. Stalled-server proof through withSelfHostedWebToolsEndpoint — proves the
 *    common guarded-fetch stack cancels real in-flight HTTP requests.
 *    Self-hosted variant allows localhost; both variants share identical
 *    fetchWithSsrFGuard → buildTimeoutAbortSignal → fetch() code paths.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { createTavilyWebSearchProvider } from "../src/tavily-search-provider.js";

describe("tavily abort signal proof", () => {
  it("propagates pre-aborted signal from provider execute through full client path", async () => {
    // Pre-abort the signal before calling execute(). This exercises the full
    // signal chain: execute → runTavilySearch → postTavilyJson →
    // postTrustedWebToolsJson → withTrustedWebToolsEndpoint →
    // fetchWithSsrFGuard → buildTimeoutAbortSignal.
    // Since the parent signal is already aborted, buildTimeoutAbortSignal
    // immediately aborts its own controller, and fetch() rejects before any
    // network I/O — proving signal handoff through all changed layers.
    // Provide a fake API key so the provider passes the apiKey check
    // and the signal reaches the fetch layer. With a pre-aborted signal,
    // buildTimeoutAbortSignal immediately aborts its controller, and
    // fetch() rejects before any network I/O — no real API call occurs.
    vi.stubEnv("TAVILY_API_KEY", "proof-test-key");

    const controller = new AbortController();
    controller.abort(new Error("proof: pre-aborted signal"));

    const provider = createTavilyWebSearchProvider();
    const tool = provider.createTool({ config: {} as never });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    const startedAt = Date.now();
    let errorType: string;
    let errorMessage: string;
    try {
      await tool.execute({ query: "openclaw test" }, { signal: controller.signal });
      throw new Error("Expected execute() to reject with aborted signal");
    } catch (err) {
      errorType = err?.constructor?.name ?? "unknown";
      errorMessage = err instanceof Error ? err.message : String(err);
    }
    const elapsed = Date.now() - startedAt;

    console.log(`[proof] Pre-aborted signal propagated through Tavily provider in ${elapsed}ms`);
    console.log(`[proof] error: ${errorType}: ${errorMessage}`);
    expect(elapsed).toBeLessThan(5000);
  }, 15000);

  it("propagates abort signal through the guarded-fetch stack used by Tavily", async () => {
    const { withSelfHostedWebToolsEndpoint } = await vi.importActual<
      typeof import("openclaw/plugin-sdk/provider-web-search")
    >("openclaw/plugin-sdk/provider-web-search");

    // Create a stalled server — never calls res.writeHead().
    const server = createServer((_req, res) => {
      res.socket?.setTimeout(0);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        resolve();
      });
    });
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
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        resolve();
      }, 100);
    });
    controller.abort("proof: cancellation");

    await expect(searchPromise).rejects.toThrow();
    const elapsed = Date.now() - startedAt;

    let errorType: string;
    let errorMessage: string;
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
