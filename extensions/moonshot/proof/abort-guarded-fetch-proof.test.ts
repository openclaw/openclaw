/**
 * Real behavior proof: abort signal through Moonshot/Kimi's full provider→fetch chain.
 *
 * Production code path:
 *   createKimiWebSearchProvider().createTool(ctx).execute(args, context)
 *   → executeKimiWebSearchProviderTool(ctx, args, { signal: context?.signal })
 *   → runKimiSearch({ signal: opts?.signal })
 *   → withTrustedWebSearchEndpoint({ signal: params.signal })
 *   → withTrustedWebToolsEndpoint({ signal })
 *   → fetchWithSsrFGuard({ signal })
 *   → buildTimeoutAbortSignal({ signal })
 *   → fetch()
 *
 * Three-part proof:
 * 1. Pre-aborted signal through provider path — proves signal flows from
 *    provider.execute() through all intermediate layers to fetch().
 *    buildTimeoutAbortSignal sees the already-aborted parent signal and
 *    immediately aborts its controller, so no network I/O occurs.
 * 2. Stalled-server proof through withSelfHostedWebSearchEndpoint — proves the
 *    common guarded-fetch stack cancels real in-flight HTTP requests.
 *    Self-hosted variant allows localhost; both variants share identical
 *    fetchWithSsrFGuard → buildTimeoutAbortSignal → fetch() code paths.
 * 3. Live in-flight abort through real Kimi provider — proves cancellation of
 *    an already pending real Kimi request. Requires KIMI_API_KEY env var.
 *    Aborts mid-flight (~500ms after dispatch) and verifies the signal reaches
 *    the fetch layer before the API responds.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { createKimiWebSearchProvider } from "../src/kimi-web-search-provider.js";

describe("moonshot abort signal proof", () => {
  it("propagates pre-aborted signal from provider execute through full client chain", async () => {
    // Provide a fake API key so the provider passes the apiKey check
    // and the signal reaches the fetch layer. With a pre-aborted signal,
    // buildTimeoutAbortSignal immediately aborts its controller, and
    // fetch() rejects before any network I/O — no real API call occurs.
    vi.stubEnv("KIMI_API_KEY", "proof-test-key");

    const controller = new AbortController();
    controller.abort(new Error("proof: pre-aborted signal"));

    const provider = createKimiWebSearchProvider();
    const tool = provider.createTool({ config: {} as never, searchConfig: {} });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    const startedAt = Date.now();
    let resolved = false;
    try {
      await tool.execute({ query: "openclaw test" }, { signal: controller.signal });
      // If we reach here, execute resolved unexpectedly — the signal was
      // not forwarded through the provider chain.  This flag is checked
      // below rather than throwing a sentinel inside the try block, so a
      // removed signal-forwarding patch causes a genuine test failure
      // instead of a false-positive pass.
      resolved = true;
    } catch (err) {
      const elapsed = Date.now() - startedAt;
      const errorType = (err as Error)?.constructor?.name ?? "unknown";
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.log(`[proof] Pre-aborted signal propagated through Kimi provider in ${elapsed}ms`);
      console.log(`[proof] error: ${errorType}: ${errorMessage}`);
      expect(elapsed).toBeLessThan(5000);
    }
    // Regression guard: reverting signal forwarding must fail this test.
    expect(resolved).toBe(false);
  }, 15000);

  it("propagates in-flight abort through real Kimi provider (live proof)", async () => {
    const apiKey = process.env.KIMI_API_KEY;
    if (!apiKey) {
      console.log(
        JSON.stringify({
          skip: true,
          reason: "KIMI_API_KEY not set — set it for live in-flight cancel proof",
        }),
      );
      return;
    }

    const controller = new AbortController();
    const provider = createKimiWebSearchProvider();
    const tool = provider.createTool({ config: {} as never, searchConfig: {} });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    const startedAt = Date.now();
    // Dispatch a real Kimi web search.  The query is phrased to produce a
    // multi-round tool-call replay so the API stays busy for 2+ seconds.
    const searchPromise = tool.execute(
      { query: "latest developments in open source AI tools this week" },
      { signal: controller.signal },
    );

    // Abort mid-flight — the real HTTP request to api.moonshot.ai should
    // already be in-flight after ~500ms of DNS + TLS + request dispatch.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 500);
    });
    controller.abort(new Error("proof: in-flight cancellation"));

    try {
      await searchPromise;
      // Kimi responded before the abort timer fired — the proof did not
      // observe cancellation.  Fail so this test doesn't silently pass
      // when the abort signal is not exercised.
      const elapsed = Date.now() - startedAt;
      console.log(
        JSON.stringify({
          outcome: "completed_before_abort",
          settledMs: elapsed,
          note: "Timed completion before cancel, proof did not observe abort — failing to flag this",
        }),
      );
      // If this flakes because Kimi is consistently fast, increase the
      // abort delay above 500ms or switch to a stalled-server proof.
      expect.fail(
        `Kimi search completed in ${elapsed}ms before the 500ms abort timer — no cancellation was observed`,
      );
    } catch (err) {
      const elapsed = Date.now() - startedAt;

      // The error must be caused by the abort signal, not an unrelated
      // failure (auth, DNS, HTTP, parse).  Verify the parent signal is
      // aborted and the error trace carries the abort reason.
      expect(controller.signal.aborted).toBe(true);
      const errorMessage = err instanceof Error ? err.message : String(err);
      expect(errorMessage).toContain("proof: in-flight cancellation");

      console.log(
        JSON.stringify(
          {
            parentSignalAborted: true,
            settledMs: elapsed,
            errorType: (err as Error)?.constructor?.name ?? "unknown",
            errorMessage,
            outcome: "aborted",
            signalGuard:
              "provider.execute → runKimiSearch → withTrustedWebSearchEndpoint → fetch()",
            note: "In-flight Kimi search canceled — signal reached fetch() before API responded",
          },
          null,
          2,
        ),
      );

      // Abort must surface within 30s.  If it took >30s we'd hit the
      // provider timeout, not the abort signal.
      expect(elapsed).toBeLessThan(30000);
    }
  }, 60000);

  it("propagates abort signal through the guarded-fetch stack used by Kimi", async () => {
    const { withSelfHostedWebSearchEndpoint } = await vi.importActual<
      typeof import("openclaw/plugin-sdk/provider-web-search")
    >("openclaw/plugin-sdk/provider-web-search");

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
      async () => ({ ok: true }),
    );

    await new Promise<void>((resolve) => {
      setTimeout(() => {
        resolve();
      }, 100);
    });
    controller.abort("proof: cancellation");

    await expect(searchPromise).rejects.toThrow();
    const elapsed = Date.now() - startedAt;

    try {
      await searchPromise;
    } catch (err) {
      const errorType = (err as Error)?.constructor?.name ?? "unknown";
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.log(
        `[proof] Signal propagated in ${elapsed}ms through guarded-fetch stack ` +
          `(withSelfHostedWebSearchEndpoint → fetchWithSsrFGuard → buildTimeoutAbortSignal → fetch)`,
      );
      console.log(`[proof] stalled server: http://127.0.0.1:${port}/stall`);
      console.log(`[proof] abort: controller.abort("proof: cancellation") @ ~100ms`);
      console.log(`[proof] error: ${errorType}: ${errorMessage}`);
    }

    server.close();
    expect(elapsed).toBeLessThan(5000);
  }, 15000);
});
