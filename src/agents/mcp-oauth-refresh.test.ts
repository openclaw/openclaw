import type { FetchLike } from "@modelcontextprotocol/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import * as leaseAcquisition from "../state/openclaw-state-lease-acquisition.js";
import { withMcpOAuthBearer } from "./mcp-oauth-fetch.js";
import { operatorMcpOAuthIdentity, requesterMcpOAuthIdentity } from "./mcp-oauth-identity.js";
import { readMcpOAuthStore } from "./mcp-oauth-store.js";
import * as oauthStore from "./mcp-oauth-store.js";
import { clearMcpOAuthCredentials, resolveMcpOAuthAccessToken } from "./mcp-oauth.js";
import { withMcpOAuthTempHome as withTempHome } from "./mcp-oauth.test-harness.js";
import {
  saveMcpOAuthAccessTokenForTest,
  withMcpOAuthProviderForTest,
  withMcpOAuthTestLease,
} from "./mcp-oauth.test-support.js";

const authMock = vi.hoisted(() => vi.fn());
const FRESH_ACCESS = "test-token-placeholder";
const ROTATED_ACCESS = "gateway-token";
const ROTATED_TOKENS = {
  access_token: ROTATED_ACCESS,
  refresh_token: "secret-token",
  token_type: "Bearer",
  expires_in: 3600,
};
const IDENTITY = operatorMcpOAuthIdentity("Remote Docs", "https://mcp.example.com/mcp");

vi.mock("@modelcontextprotocol/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@modelcontextprotocol/client")>()),
  auth: authMock,
}));

describe("MCP OAuth provider", () => {
  beforeEach(() => authMock.mockReset());

  it("does not send a bearer when the caller cancels during the stored token read", async () => {
    await withTempHome(async () => {
      await saveMcpOAuthAccessTokenForTest(IDENTITY, FRESH_ACCESS);

      const controller = new AbortController();
      const read = oauthStore.readMcpOAuthStoreReadOnly;
      using reading = vi
        .spyOn(oauthStore, "readMcpOAuthStoreReadOnly")
        .mockImplementationOnce(async (...args) => {
          const store = await read(...args);
          controller.abort();
          return store;
        });
      const resourceFetch = vi.fn<FetchLike>(async () => new Response("ok"));
      await expect(
        withMcpOAuthBearer({
          identity: IDENTITY,
          fetchFn: resourceFetch,
          authFetchFn: resourceFetch,
        })(IDENTITY.serverUrl, { signal: controller.signal }),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(reading).toHaveBeenCalledOnce();
      expect(resourceFetch).not.toHaveBeenCalled();
      expect(authMock).not.toHaveBeenCalled();
    }, "openclaw-mcp-oauth-cancelled-read-");
  });

  it("sends only the current requester's stored bearer through the resource fetch path", async () => {
    await withTempHome(async () => {
      const requester = requesterMcpOAuthIdentity(IDENTITY.serverName, IDENTITY.serverUrl, {
        messageChannel: "slack",
        requesterSenderId: "U123",
      });
      await saveMcpOAuthAccessTokenForTest(IDENTITY, FRESH_ACCESS);
      await saveMcpOAuthAccessTokenForTest(requester, "requester-token");
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
        using acquisition = vi
          .spyOn(leaseAcquisition, "acquireOpenClawStateLease")
          .mockImplementation((params) => acquire({ ...params, waitMs: 0 }));
        await expect(send(IDENTITY)).resolves.toMatchObject({ status: 200 });
        await expect(send(requester)).resolves.toMatchObject({ status: 200 });
        expect(acquisition).not.toHaveBeenCalled();
      });
      await saveMcpOAuthAccessTokenForTest(IDENTITY, ROTATED_ACCESS);
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
    }, "openclaw-mcp-oauth-bearer-held-lease-");
  });

  it("does not restore a stale challenge after a concurrent refresh rotates the token", async () => {
    await withTempHome(async () => {
      await saveMcpOAuthAccessTokenForTest(IDENTITY, "decoy-token");

      const refreshStarted = createDeferred();
      const refreshGate = createDeferred();
      authMock.mockImplementationOnce(async (refreshProvider) => {
        await refreshProvider.saveTokens(ROTATED_TOKENS);
        refreshStarted.resolve();
        await refreshGate.promise;
        return "AUTHORIZED";
      });

      const first = resolveMcpOAuthAccessToken({
        identity: IDENTITY,
        authorizationChallenge: true,
        rejectedAccessToken: "decoy-token",
        scope: "docs.read",
      });
      await refreshStarted.promise;
      const second = resolveMcpOAuthAccessToken({
        identity: IDENTITY,
        authorizationChallenge: true,
        rejectedAccessToken: "decoy-token",
        scope: "stale.scope",
      });
      refreshGate.resolve();

      await expect(Promise.all([first, second])).resolves.toEqual([ROTATED_ACCESS, ROTATED_ACCESS]);
      expect(authMock).toHaveBeenCalledOnce();
      expect(
        (await readMcpOAuthStore(IDENTITY.storeKey)).pendingAuthorizationChallenge,
      ).toBeUndefined();
    }, "openclaw-mcp-oauth-concurrent-challenge-");
  });

  it("does not let a completed refresh resurrect a concurrent logout", async () => {
    await withTempHome(async () => {
      await saveMcpOAuthAccessTokenForTest(IDENTITY, "decoy-token", -1);
      const started = createDeferred();
      const gate = createDeferred();
      authMock.mockImplementationOnce(async (refreshProvider) => {
        started.resolve();
        await gate.promise;
        await refreshProvider.saveTokens(ROTATED_TOKENS);
        return "AUTHORIZED";
      });

      const refresh = resolveMcpOAuthAccessToken({
        identity: IDENTITY,
        config: { scope: "docs.read" },
      });
      await started.promise;
      expect(authMock.mock.calls[0]?.[1]).toMatchObject({
        serverUrl: IDENTITY.serverUrl,
        scope: "docs.read",
      });
      const logout = clearMcpOAuthCredentials(IDENTITY);
      gate.resolve();

      await expect(refresh).resolves.toBe(ROTATED_ACCESS);
      expect(authMock).toHaveBeenCalledOnce();
      await logout;
      expect(
        await withMcpOAuthProviderForTest({ identity: IDENTITY }, async (provider) =>
          provider.tokens(),
        ),
      ).toBeUndefined();
    }, "openclaw-mcp-oauth-refresh-logout-");
  });
});
