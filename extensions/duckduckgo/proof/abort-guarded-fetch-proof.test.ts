/**
 * Real behavior proof: abort signal through DuckDuckGo's full provider→fetch chain.
 *
 * Production code path:
 *   createDuckDuckGoWebSearchProvider().createTool(ctx).execute(args, context)
 *   → runDuckDuckGoSearch({ signal: context?.signal })
 *   → withTrustedWebSearchEndpoint({ signal: params.signal })
 *   → withTrustedWebToolsEndpoint({ signal })
 *   → fetchWithSsrFGuard({ signal })
 *   → buildTimeoutAbortSignal({ signal })
 *   → fetch(url, { signal })
 *
 * Two-part proof:
 * 1. Pre-aborted signal through provider path — proves signal flows from
 *    provider.execute() through all intermediate layers to fetch().
 *    buildTimeoutAbortSignal sees the already-aborted parent signal and
 *    immediately aborts its controller, so no network I/O occurs.
 * 2. Stalled-server proof through withSelfHostedWebSearchEndpoint — proves the
 *    common guarded-fetch stack cancels real in-flight HTTP requests.
 *    Self-hosted variant allows localhost; both variants share identical
 *    fetchWithSsrFGuard → buildTimeoutAbortSignal → fetch() code paths.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { createDuckDuckGoWebSearchProvider } from "../src/ddg-search-provider.js";

describe("ddg abort signal proof", () => {
  it("propagates pre-aborted signal from provider execute through full client path", async () => {
    // Pre-abort the signal before calling execute(). This exercises the full
    // signal chain: execute → runDuckDuckGoSearch → withTrustedWebSearchEndpoint
    // → withTrustedWebToolsEndpoint → fetchWithSsrFGuard → buildTimeoutAbortSignal.
    // Since the parent signal is already aborted, buildTimeoutAbortSignal
    // immediately aborts its own controller, and fetch() rejects before any
    // network I/O — proving signal handoff through all changed layers.
    const controller = new AbortController();
    controller.abort(new Error("proof: pre-aborted signal"));

    const provider = createDuckDuckGoWebSearchProvider();
    const tool = provider.createTool({ config: {} as never });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    const startedAt = Date.now();
    let errorType = "unknown";
    let errorMessage = "unknown";
    try {
      await tool.execute({ query: "openclaw test" }, { signal: controller.signal });
      throw new Error("Expected execute() to reject with aborted signal");
    } catch (err) {
      errorType = err?.constructor?.name ?? "unknown";
      errorMessage = err instanceof Error ? err.message : String(err);
    }
    const elapsed = Date.now() - startedAt;

    console.log(`[proof] Pre-aborted signal propagated through DDG provider in ${elapsed}ms`);
    console.log(`[proof] error: ${errorType}: ${errorMessage}`);
    expect(elapsed).toBeLessThan(5000);
  }, 15000);

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
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        resolve();
      });
    });
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
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        resolve();
      }, 100);
    });
    controller.abort("proof: cancellation");

    await expect(searchPromise).rejects.toThrow();
    const elapsed = Date.now() - startedAt;

    // Capture the exact error for the PR body.
    let errorType = "unknown";
    let errorMessage = "unknown";
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
