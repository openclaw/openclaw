// Covers MCP OAuth token refresh, lease cancellation, and concurrency.
import path from "node:path";
import type { FetchLike } from "@modelcontextprotocol/client";
import { withTempHome as withBaseTempHome } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import * as leaseAcquisition from "../state/openclaw-state-lease-acquisition.js";
import { withMcpOAuthBearer } from "./mcp-oauth-fetch.js";
import { operatorMcpOAuthIdentity, requesterMcpOAuthIdentity } from "./mcp-oauth-identity.js";
import { readMcpOAuthStore } from "./mcp-oauth-store.js";
import * as oauthStore from "./mcp-oauth-store.js";
import { clearMcpOAuthCredentials, resolveMcpOAuthAccessToken } from "./mcp-oauth.js";
import { withMcpOAuthProviderForTest, withMcpOAuthTestLease } from "./mcp-oauth.test-support.js";

const authMock = vi.hoisted(() => vi.fn());
const FRESH_ACCESS = "test-token-placeholder";
const ROTATED_ACCESS = "gateway-token";
const IDENTITY = operatorMcpOAuthIdentity("Remote Docs", "https://mcp.example.com/mcp");

vi.mock("@modelcontextprotocol/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@modelcontextprotocol/client")>()),
  auth: authMock,
}));

async function withTempHome<T>(
  run: (home: string) => T | Promise<T>,
  options: Parameters<typeof withBaseTempHome>[1],
): Promise<T> {
  return withBaseTempHome(async (home) => {
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = path.join(home, ".openclaw");
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    try {
      return await run(home);
    } finally {
      await closeOpenClawStateDatabaseAsync();
      closeOpenClawStateDatabaseForTest();
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
    }
  }, options);
}

describe("MCP OAuth provider", () => {
  beforeEach(async () => {
    authMock.mockReset();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
  });

  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
  });

  it("returns a fresh stored access token without refreshing it", async () => {
    await withTempHome(
      async () => {
        await withMcpOAuthProviderForTest(
          {
            identity: IDENTITY,
          },
          async (provider) => {
            await provider.saveTokens({
              access_token: "test-token-placeholder",
              refresh_token: "test-auth-token",
              token_type: "Bearer",
              expires_in: 3600,
            });
          },
        );

        await expect(
          resolveMcpOAuthAccessToken({
            identity: IDENTITY,
          }),
        ).resolves.toBe(FRESH_ACCESS);
        expect(authMock).not.toHaveBeenCalled();
      },
      {
        prefix: "openclaw-mcp-oauth-fresh-token-",
        skipSessionCleanup: true,
        env: {
          OPENCLAW_CONFIG_PATH: undefined,
          OPENCLAW_STATE_DIR: undefined,
        },
      },
    );
  });

  it("does not send a bearer when the caller cancels during the stored token read", async () => {
    await withTempHome(
      async () => {
        await withMcpOAuthProviderForTest({ identity: IDENTITY }, async (provider) => {
          await provider.saveTokens({
            access_token: FRESH_ACCESS,
            refresh_token: "test-auth-token",
            token_type: "Bearer",
            expires_in: 3600,
          });
        });

        const controller = new AbortController();
        const read = oauthStore.readMcpOAuthStoreReadOnly;
        const reading = vi
          .spyOn(oauthStore, "readMcpOAuthStoreReadOnly")
          .mockImplementationOnce(async (...args) => {
            const store = await read(...args);
            controller.abort();
            return store;
          });
        const resourceFetch = vi.fn<FetchLike>(async () => new Response("ok"));
        try {
          await expect(
            withMcpOAuthBearer({
              identity: IDENTITY,
              fetchFn: resourceFetch,
              authFetchFn: resourceFetch,
            })(IDENTITY.serverUrl, { signal: controller.signal }),
          ).rejects.toMatchObject({ name: "AbortError" });
          expect(resourceFetch).not.toHaveBeenCalled();
        } finally {
          reading.mockRestore();
        }
        expect(authMock).not.toHaveBeenCalled();
      },
      {
        prefix: "openclaw-mcp-oauth-cancelled-read-",
        skipSessionCleanup: true,
        env: { OPENCLAW_CONFIG_PATH: undefined, OPENCLAW_STATE_DIR: undefined },
      },
    );
  });

  it("sends only the current requester's stored bearer through the resource fetch path", async () => {
    await withTempHome(
      async () => {
        const requester = requesterMcpOAuthIdentity(IDENTITY.serverName, IDENTITY.serverUrl, {
          messageChannel: "slack",
          requesterSenderId: "U123",
        });
        const save = async (identity: typeof IDENTITY, accessToken: string) =>
          await withMcpOAuthProviderForTest({ identity }, async (provider) => {
            await provider.saveTokens({
              access_token: accessToken,
              refresh_token: "test-auth-token",
              token_type: "Bearer",
              expires_in: 3600,
            });
          });
        await save(IDENTITY, FRESH_ACCESS);
        await save(requester, "requester-token");
        const resourceFetch = vi.fn<FetchLike>(async () => new Response("ok"));
        const sentBearer = (index: number) =>
          new Headers(resourceFetch.mock.calls[index]?.[1]?.headers).get("authorization");
        const send = (identity: typeof IDENTITY) =>
          withMcpOAuthBearer({ fetchFn: resourceFetch, authFetchFn: resourceFetch, identity })(
            IDENTITY.serverUrl,
            { method: "POST", body: "{}" },
          );

        await withMcpOAuthTestLease(IDENTITY.storeKey, async () => {
          // The real held lease fails immediately if a fresh-token request tries to acquire it.
          const acquire = leaseAcquisition.acquireOpenClawStateLease;
          const acquisition = vi
            .spyOn(leaseAcquisition, "acquireOpenClawStateLease")
            .mockImplementation((params) => acquire({ ...params, waitMs: 0 }));
          try {
            await expect(send(IDENTITY)).resolves.toMatchObject({ status: 200 });
            await expect(send(requester)).resolves.toMatchObject({ status: 200 });
          } finally {
            acquisition.mockRestore();
          }
        });
        await save(IDENTITY, ROTATED_ACCESS);
        await expect(send(IDENTITY)).resolves.toMatchObject({ status: 200 });
        await clearMcpOAuthCredentials(IDENTITY);
        await expect(send(IDENTITY)).resolves.toMatchObject({ status: 200 });

        expect([0, 1, 2, 3].map(sentBearer)).toEqual([
          `Bearer ${FRESH_ACCESS}`,
          "Bearer requester-token",
          `Bearer ${ROTATED_ACCESS}`,
          null,
        ]);
        expect(authMock).not.toHaveBeenCalled();
      },
      {
        prefix: "openclaw-mcp-oauth-bearer-held-lease-",
        skipSessionCleanup: true,
        env: { OPENCLAW_CONFIG_PATH: undefined, OPENCLAW_STATE_DIR: undefined },
      },
    );
  });

  it("refreshes an expired stored access token before projecting it", async () => {
    await withTempHome(
      async () => {
        await withMcpOAuthProviderForTest(
          {
            identity: IDENTITY,
          },
          async (provider) => {
            await provider.saveTokens({
              access_token: "decoy-token",
              refresh_token: "test-auth-token",
              token_type: "Bearer",
              expires_in: -1,
            });
          },
        );
        authMock.mockImplementationOnce(async (refreshProvider) => {
          await refreshProvider.saveTokens({
            access_token: "gateway-token",
            refresh_token: "secret-token",
            token_type: "Bearer",
            expires_in: 3600,
          });
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
      },
      {
        prefix: "openclaw-mcp-oauth-expired-token-",
        skipSessionCleanup: true,
        env: {
          OPENCLAW_CONFIG_PATH: undefined,
          OPENCLAW_STATE_DIR: undefined,
        },
      },
    );
  });

  it("does not restore a stale challenge after a concurrent refresh rotates the token", async () => {
    await withTempHome(
      async () => {
        await withMcpOAuthProviderForTest(
          {
            identity: IDENTITY,
          },
          async (provider) => {
            await provider.saveTokens({
              access_token: "decoy-token",
              refresh_token: "test-auth-token",
              token_type: "Bearer",
              expires_in: 3600,
            });
          },
        );

        let signalRefreshStarted: (() => void) | undefined;
        const refreshStarted = new Promise<void>((resolve) => {
          signalRefreshStarted = resolve;
        });
        let releaseRefresh: (() => void) | undefined;
        const refreshGate = new Promise<void>((resolve) => {
          releaseRefresh = resolve;
        });
        authMock.mockImplementationOnce(async (refreshProvider) => {
          await refreshProvider.saveTokens({
            access_token: "gateway-token",
            refresh_token: "secret-token",
            token_type: "Bearer",
            expires_in: 3600,
          });
          signalRefreshStarted?.();
          await refreshGate;
          return "AUTHORIZED";
        });

        const first = resolveMcpOAuthAccessToken({
          identity: IDENTITY,
          authorizationChallenge: true,
          rejectedAccessToken: "decoy-token",
          scope: "docs.read",
        });
        await refreshStarted;
        const second = resolveMcpOAuthAccessToken({
          identity: IDENTITY,
          authorizationChallenge: true,
          rejectedAccessToken: "decoy-token",
          scope: "stale.scope",
        });
        releaseRefresh?.();

        await expect(Promise.all([first, second])).resolves.toEqual([
          ROTATED_ACCESS,
          ROTATED_ACCESS,
        ]);
        expect(authMock).toHaveBeenCalledOnce();
        expect(
          (await readMcpOAuthStore(IDENTITY.storeKey)).pendingAuthorizationChallenge,
        ).toBeUndefined();
      },
      {
        prefix: "openclaw-mcp-oauth-concurrent-challenge-",
        skipSessionCleanup: true,
        env: { OPENCLAW_CONFIG_PATH: undefined, OPENCLAW_STATE_DIR: undefined },
      },
    );
  });

  it("does not let a completed refresh resurrect a concurrent logout", async () => {
    await withTempHome(
      async () => {
        await withMcpOAuthProviderForTest(
          {
            identity: IDENTITY,
          },
          async (provider) => {
            await provider.saveTokens({
              access_token: "decoy-token",
              refresh_token: "test-auth-token",
              token_type: "Bearer",
              expires_in: -1,
            });
          },
        );
        let signalStarted: (() => void) | undefined;
        const started = new Promise<void>((resolve) => {
          signalStarted = resolve;
        });
        let releaseRefresh: (() => void) | undefined;
        const gate = new Promise<void>((resolve) => {
          releaseRefresh = resolve;
        });
        authMock.mockImplementationOnce(async (refreshProvider) => {
          signalStarted?.();
          await gate;
          await refreshProvider.saveTokens({
            access_token: "gateway-token",
            refresh_token: "secret-token",
            token_type: "Bearer",
            expires_in: 3600,
          });
          return "AUTHORIZED";
        });

        const refresh = resolveMcpOAuthAccessToken({
          identity: IDENTITY,
        });
        await started;
        const logout = clearMcpOAuthCredentials(IDENTITY);
        releaseRefresh?.();

        await expect(refresh).resolves.toBe(ROTATED_ACCESS);
        await logout;
        expect(
          await withMcpOAuthProviderForTest(
            {
              identity: IDENTITY,
            },
            async (provider) => await provider.tokens(),
          ),
        ).toBeUndefined();
      },
      {
        prefix: "openclaw-mcp-oauth-refresh-logout-",
        skipSessionCleanup: true,
        env: { OPENCLAW_CONFIG_PATH: undefined, OPENCLAW_STATE_DIR: undefined },
      },
    );
  });
});
