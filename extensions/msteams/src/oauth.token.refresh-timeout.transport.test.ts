// Production refreshMSTeamsDelegatedTokens must abort when the token endpoint
// never responds. URL is rewritten onto loopback only so the rest of
// fetchWithSsrFGuard + fetchMSTeamsTokens stays the production caller.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

const rewrite = vi.hoisted(() => ({ url: "" }));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: async (opts: Parameters<typeof actual.fetchWithSsrFGuard>[0]) =>
      actual.fetchWithSsrFGuard({
        ...opts,
        url: rewrite.url || opts.url,
        policy: { allowPrivateNetwork: true },
      }),
  };
});

const { refreshMSTeamsDelegatedTokens } = await import("./oauth.token.js");
const { MSTEAMS_DEFAULT_TOKEN_FETCH_TIMEOUT_MS } = await import("./oauth.shared.js");

describe("MS Teams token refresh hanging endpoint transport", () => {
  afterEach(() => {
    rewrite.url = "";
  });

  it("refreshMSTeamsDelegatedTokens times out when the token endpoint never responds", async () => {
    let fetchStarted = false;
    const server = createServer((_req, res) => {
      fetchStarted = true;
      res.socket?.resume();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address() as AddressInfo;
    rewrite.url = `http://127.0.0.1:${address.port}/oauth2/v2.0/token`;

    const started = Date.now();
    const outcome = await refreshMSTeamsDelegatedTokens({
      tenantId: "tenant-1",
      clientId: "client-1",
      clientSecret: "client-secret",
      refreshToken: "refresh-token",
    }).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    const elapsedMs = Date.now() - started;
    server.close();

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toMatchObject({
        name: "TimeoutError",
        message: "request timed out",
      });
    }
    expect(elapsedMs).toBeGreaterThanOrEqual(MSTEAMS_DEFAULT_TOKEN_FETCH_TIMEOUT_MS - 1_500);
    expect(elapsedMs).toBeLessThan(MSTEAMS_DEFAULT_TOKEN_FETCH_TIMEOUT_MS + 4_000);
    console.log(
      `[msteams refreshMSTeamsDelegatedTokens hanging endpoint proof] timed_out=${!outcome.ok} elapsed_ms=${elapsedMs} fetch_started=${fetchStarted} production_timeout_ms=${MSTEAMS_DEFAULT_TOKEN_FETCH_TIMEOUT_MS}`,
    );
  }, 20_000);
});
