/**
 * Real behavior proof: abort signal through the guarded-fetch stack used by Exa.
 *
 * Exa production code path:
 *   executeExaWebSearchProviderTool (exa-web-search-provider.runtime.ts)
 *   → runExaSearch({ signal })
 *   → withTrustedWebSearchEndpoint({ signal }) (web-search-provider-common.ts)
 *   → withTrustedWebToolsEndpoint (web-guarded-fetch.ts)
 *   → fetchWithSsrFGuard (fetch-guard.ts)
 *   → buildTimeoutAbortSignal → fetch()
 *
 * This proof uses withSelfHostedWebSearchEndpoint — the localhost-allowed
 * sibling. Both share identical fetchWithSsrFGuard → buildTimeoutAbortSignal
 * → fetch() code paths; only the SSRF policy object differs.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";

describe("exa abort signal proof", () => {
  it("propagates abort signal through the guarded-fetch stack used by Exa", async () => {
    const { withSelfHostedWebSearchEndpoint } = await vi.importActual<
      typeof import("openclaw/plugin-sdk/provider-web-search")
    >("openclaw/plugin-sdk/provider-web-search");

    const server = createServer((_req, res) => {
      res.socket?.setTimeout(0);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
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
      async () => ({ ok: true }),
    );

    await new Promise<void>((resolve) => {
      setTimeout(() => resolve(), 100);
    });
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
        `(withSelfHostedWebSearchEndpoint → fetchWithSsrFGuard → buildTimeoutAbortSignal → fetch)`,
    );
    console.log(`[proof] stalled server: http://127.0.0.1:${port}/stall`);
    console.log(`[proof] abort: controller.abort("proof: cancellation") @ ~100ms`);
    console.log(`[proof] error: ${errorType}: ${errorMessage}`);

    server.close();
    expect(elapsed).toBeLessThan(5000);
  }, 15000);
});
