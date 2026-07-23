// Real guarded-fetch path: no fetchWithSsrFGuard mock.
// Locks guard-owned timeoutMs at the refreshMSTeamsDelegatedTokens entry point.
// Shared SSRF suites cover stalled DNS; this asserts Teams token refresh still
// forwards timeoutMs into that owner so preflight abort happens before HTTP
// dispatch. Do not rewrite this to AbortSignal.timeout() / init.signal — that
// would regress the guard-owned contract (#105549). Sibling graph.ts already
// passes top-level timeoutMs.
import type { LookupFn } from "openclaw/plugin-sdk/ssrf-runtime";
import { describe, expect, it, vi } from "vitest";
import { refreshMSTeamsDelegatedTokens } from "./oauth.token.js";

describe("refreshMSTeamsDelegatedTokens preflight timeout", () => {
  it("times out when preflight lookup stalls before HTTP dispatch", async () => {
    const stalledLookup: LookupFn = (() => new Promise<never>(() => {})) as LookupFn;
    const fetchSpy = vi.fn(async () => new Response("should not run"));

    const started = Date.now();
    const outcome = await refreshMSTeamsDelegatedTokens({
      tenantId: "tenant-1",
      clientId: "client-1",
      clientSecret: "secret-1", // pragma: allowlist secret
      refreshToken: "original-rt",
      fetchImpl: fetchSpy,
      lookupFn: stalledLookup,
      timeoutMs: 80,
    }).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    const elapsedMs = Date.now() - started;

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toMatchObject({
        name: "TimeoutError",
        message: "request timed out",
      });
    }
    expect(elapsedMs).toBeGreaterThanOrEqual(60);
    expect(elapsedMs).toBeLessThan(2_000);
    expect(fetchSpy).not.toHaveBeenCalled();
    console.log(
      `[msteams token refresh preflight stall proof] timed_out=${!outcome.ok} name=${
        outcome.ok ? "n/a" : (outcome.error as Error).name
      } message=${
        outcome.ok ? "n/a" : (outcome.error as Error).message
      } elapsed_ms=${elapsedMs} fetch_called=${fetchSpy.mock.calls.length}`,
    );
  });
});
