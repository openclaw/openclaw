import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { operatorMcpOAuthIdentity } from "./mcp-oauth-identity.js";
import { readMcpOAuthStore } from "./mcp-oauth-store.js";
import { clearMcpOAuthCredentials, resolveMcpOAuthAccessToken } from "./mcp-oauth.js";
import { withTempHome as withBaseTempHome } from "./mcp-oauth.test-harness.js";
import { withMcpOAuthProviderForTest } from "./mcp-oauth.test-support.js";

const authMock = vi.hoisted(() => vi.fn());
const FRESH_ACCESS = "test-token-placeholder";
const ROTATED_ACCESS = "gateway-token";
const IDENTITY = operatorMcpOAuthIdentity("Remote Docs", "https://mcp.example.com/mcp");

vi.mock("@modelcontextprotocol/sdk/client/auth.js", () => ({
  auth: authMock,
}));

function withTempHome<T>(run: (home: string) => T | Promise<T>, prefix: string) {
  return withBaseTempHome(run, {
    prefix,
    skipSessionCleanup: true,
    env: { OPENCLAW_CONFIG_PATH: undefined, OPENCLAW_STATE_DIR: undefined },
  });
}

function makeTokens(access_token: string, refresh_token: string, expires_in = 3600) {
  return { access_token, refresh_token, token_type: "Bearer", expires_in };
}

function withProvider<T>(run: (provider: OAuthClientProvider) => Promise<T>) {
  return withMcpOAuthProviderForTest({ identity: IDENTITY }, run);
}

function saveTokens(tokens: Parameters<OAuthClientProvider["saveTokens"]>[0]) {
  return withProvider((provider) => provider.saveTokens(tokens));
}

describe("MCP OAuth provider", () => {
  beforeEach(() => {
    authMock.mockReset();
  });

  it("returns a fresh stored access token without refreshing it", async () => {
    await withTempHome(async () => {
      await saveTokens(makeTokens("test-token-placeholder", "test-auth-token"));

      await expect(resolveMcpOAuthAccessToken({ identity: IDENTITY })).resolves.toBe(FRESH_ACCESS);
      expect(authMock).not.toHaveBeenCalled();
    }, "openclaw-mcp-oauth-fresh-token-");
  });

  it("aborts an in-flight refresh, preserves tokens, and releases its lease", async () => {
    await withTempHome(async () => {
      await saveTokens(makeTokens("decoy-token", "test-auth-token", -1));
      const started = createDeferredCore<void>();
      let refreshSignal: AbortSignal | undefined;
      const fetchFn = vi.fn(
        async (_url: string | URL, init?: RequestInit): Promise<Response> =>
          await new Promise<Response>((_resolve, reject) => {
            refreshSignal = init?.signal ?? undefined;
            const rejectAbort = () => {
              const abortReason = refreshSignal?.reason;
              reject(abortReason instanceof Error ? abortReason : new Error("refresh aborted"));
            };
            if (refreshSignal?.aborted) {
              rejectAbort();
            } else {
              refreshSignal?.addEventListener("abort", rejectAbort, { once: true });
            }
            started.resolve();
          }),
      );
      authMock.mockImplementationOnce(async (_refreshProvider, options) => {
        await options.fetchFn("https://auth.example.com/token");
        return "AUTHORIZED";
      });
      const controller = new AbortController();

      const refresh = resolveMcpOAuthAccessToken({
        identity: IDENTITY,
        fetchFn,
        signal: controller.signal,
      });
      await started.promise;
      controller.abort(new Error("request stopped"));

      await expect(refresh).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_ABORTED" });
      expect(refreshSignal).toMatchObject({ aborted: true });
      expect(await withProvider(async (provider) => await provider.tokens())).toMatchObject({
        access_token: "decoy-token",
        refresh_token: "test-auth-token",
      });
      const leaseCount = openOpenClawStateDatabase()
        .db.prepare("SELECT COUNT(*) AS count FROM state_leases WHERE scope = ?")
        .get("core:mcp-oauth") as { count: number };
      expect(leaseCount.count).toBe(0);
    }, "openclaw-mcp-oauth-aborted-refresh-");
  });

  it("refreshes an expired stored access token before projecting it", async () => {
    await withTempHome(async () => {
      await saveTokens(makeTokens("decoy-token", "test-auth-token", -1));
      authMock.mockImplementationOnce(async (refreshProvider) => {
        await refreshProvider.saveTokens(makeTokens("gateway-token", "secret-token"));
        return "AUTHORIZED";
      });

      await expect(
        resolveMcpOAuthAccessToken({
          identity: IDENTITY,
          config: { scope: "docs.read" },
        }),
      ).resolves.toBe(ROTATED_ACCESS);
      expect(authMock).toHaveBeenCalledOnce();
      expect(authMock.mock.calls[0]?.[1]).toMatchObject({
        serverUrl: "https://mcp.example.com/mcp",
        scope: "docs.read",
      });
    }, "openclaw-mcp-oauth-expired-token-");
  });

  it("serializes concurrent refreshes for the same OAuth credential store", async () => {
    await withTempHome(async () => {
      await saveTokens(makeTokens("decoy-token", "test-auth-token", -1));

      const started = createDeferredCore<void>();
      const gate = createDeferredCore<void>();
      authMock.mockImplementationOnce(async (refreshProvider) => {
        started.resolve();
        await gate.promise;
        await refreshProvider.saveTokens(makeTokens("gateway-token", "secret-token"));
        return "AUTHORIZED";
      });

      const first = resolveMcpOAuthAccessToken({ identity: IDENTITY });
      await started.promise;
      const second = resolveMcpOAuthAccessToken({ identity: IDENTITY });
      gate.resolve();

      await expect(Promise.all([first, second])).resolves.toEqual([ROTATED_ACCESS, ROTATED_ACCESS]);
      expect(authMock).toHaveBeenCalledOnce();
    }, "openclaw-mcp-oauth-concurrent-refresh-");
  });

  it("does not restore a stale challenge after a concurrent refresh rotates the token", async () => {
    await withTempHome(async () => {
      await saveTokens(makeTokens("decoy-token", "test-auth-token"));

      const started = createDeferredCore<void>();
      const gate = createDeferredCore<void>();
      authMock.mockImplementationOnce(async (refreshProvider) => {
        await refreshProvider.saveTokens(makeTokens("gateway-token", "secret-token"));
        started.resolve();
        await gate.promise;
        return "AUTHORIZED";
      });

      const first = resolveMcpOAuthAccessToken({
        identity: IDENTITY,
        authorizationChallenge: true,
        rejectedAccessToken: "decoy-token",
        scope: "docs.read",
      });
      await started.promise;
      const second = resolveMcpOAuthAccessToken({
        identity: IDENTITY,
        authorizationChallenge: true,
        rejectedAccessToken: "decoy-token",
        scope: "stale.scope",
      });
      gate.resolve();

      await expect(Promise.all([first, second])).resolves.toEqual([ROTATED_ACCESS, ROTATED_ACCESS]);
      expect(authMock).toHaveBeenCalledOnce();
      expect(
        (await readMcpOAuthStore(IDENTITY.storeKey)).pendingAuthorizationChallenge,
      ).toBeUndefined();
    }, "openclaw-mcp-oauth-concurrent-challenge-");
  });

  it("does not let a completed refresh resurrect a concurrent logout", async () => {
    await withTempHome(async () => {
      await saveTokens(makeTokens("decoy-token", "test-auth-token", -1));
      const started = createDeferredCore<void>();
      const gate = createDeferredCore<void>();
      authMock.mockImplementationOnce(async (refreshProvider) => {
        started.resolve();
        await gate.promise;
        await refreshProvider.saveTokens(makeTokens("gateway-token", "secret-token"));
        return "AUTHORIZED";
      });

      const refresh = resolveMcpOAuthAccessToken({ identity: IDENTITY });
      await started.promise;
      const logout = clearMcpOAuthCredentials(IDENTITY);
      gate.resolve();

      await expect(refresh).resolves.toBe(ROTATED_ACCESS);
      await logout;
      expect(await withProvider(async (provider) => await provider.tokens())).toBeUndefined();
    }, "openclaw-mcp-oauth-refresh-logout-");
  });
});
