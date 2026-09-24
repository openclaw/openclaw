// Real guarded-fetch owner used by production token refresh: stalled DNS
// preflight must abort before HTTP dispatch when timeoutMs is set.
import { fetchWithSsrFGuard, type LookupFn } from "openclaw/plugin-sdk/ssrf-runtime";
import { describe, expect, it, vi } from "vitest";
import { MSTEAMS_DEFAULT_TOKEN_FETCH_TIMEOUT_MS } from "./oauth.shared.js";

describe("MS Teams token fetch guard timeout contract", () => {
  it("real fetchWithSsrFGuard times out when preflight lookup stalls", async () => {
    const stalledLookup: LookupFn = (() => new Promise<never>(() => {})) as LookupFn;
    const fetchSpy = vi.fn(async () => new Response("should not run"));
    const started = Date.now();
    const outcome = await fetchWithSsrFGuard({
      url: "https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token",
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          Accept: "application/json",
        },
        body: "grant_type=refresh_token",
      },
      auditContext: "msteams-oauth-token-refresh",
      timeoutMs: 80,
      fetchImpl: fetchSpy,
      lookupFn: stalledLookup,
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
      `[msteams token guard preflight stall proof] timed_out=${!outcome.ok} elapsed_ms=${elapsedMs} fetch_called=${fetchSpy.mock.calls.length} production_timeout_ms=${MSTEAMS_DEFAULT_TOKEN_FETCH_TIMEOUT_MS}`,
    );
  });
});
