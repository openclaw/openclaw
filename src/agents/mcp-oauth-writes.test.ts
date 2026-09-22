import { expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { operatorMcpOAuthIdentity, requesterMcpOAuthStoreKeyPrefix } from "./mcp-oauth-identity.js";
import { createMcpOAuthClientProvider } from "./mcp-oauth-provider.js";
import {
  clearMcpOAuthStore,
  consumeOAuthState,
  deleteMcpOAuthPendingAuthorization,
  deleteMcpOAuthPendingAuthorizationsByPrefix,
  readMcpOAuthPendingAuthorization,
  readMcpOAuthStore,
  writeMcpOAuthPendingAuthorization,
} from "./mcp-oauth-store.js";
import { withMcpOAuthTestLease } from "./mcp-oauth.test-support.js";

it("persists SDK callbacks and pending state across close without parent SQL or waits", async () => {
  await withOpenClawTestState({ label: "mcp-oauth-worker-writes" }, async () => {
    const { DatabaseSync, StatementSync } = requireNodeSqlite();
    const identity = operatorMcpOAuthIdentity("worker-writes", "https://mcp.example.test/rpc");
    const tokens = {
      access_token: "fixture-access",
      refresh_token: "fixture-refresh",
      token_type: "Bearer",
      expires_in: 3600,
    };
    const discovery = { authorizationServerUrl: "https://issuer.example.test" };
    const redirectUrl = "https://gateway.example.test/oauth/mcp/callback";
    const authorizationUrl = new URL("https://issuer.example.test/authorize?state=fixture-state");
    const parentCalls = {
      prepare: vi.spyOn(DatabaseSync.prototype, "prepare"),
      exec: vi.spyOn(DatabaseSync.prototype, "exec"),
      close: vi.spyOn(DatabaseSync.prototype, "close"),
      get: vi.spyOn(StatementSync.prototype, "get"),
      all: vi.spyOn(StatementSync.prototype, "all"),
      run: vi.spyOn(StatementSync.prototype, "run"),
      iterate: vi.spyOn(StatementSync.prototype, "iterate"),
      wait: vi.spyOn(Atomics, "wait"),
    };
    try {
      await withMcpOAuthTestLease(identity.storeKey, async (lease, context) => {
        const provider = await createMcpOAuthClientProvider({
          identity,
          lease,
          storeContext: context,
          config: { redirectUrl },
          allowAuthorizationRedirect: true,
        });
        await provider.saveClientInformation?.({ client_id: "fixture-client" });
        await provider.saveDiscoveryState?.(discovery);
        const supplied = { ...tokens };
        const saving = provider.saveTokens(supplied);
        supplied.access_token = "changed-after-callback";
        await saving;
        expect(await provider.tokens()).toEqual(tokens);
        expect(await readMcpOAuthStore(identity.storeKey, context)).toMatchObject({
          tokensAuthorizationServerUrl: discovery.authorizationServerUrl,
          tokenExpiresAt: expect.any(Number),
        });
        expect(provider.saveCodeVerifier("fixture-verifier")).toBeUndefined();
        expect((await readMcpOAuthStore(identity.storeKey, context)).codeVerifier).toBeUndefined();
        expect(await provider.codeVerifier()).toBe("fixture-verifier");
        await provider.redirectToAuthorization(authorizationUrl);
        expect(provider.redirectUrl).toBe(redirectUrl);
        expect(provider.clientMetadata.redirect_uris).toEqual([redirectUrl]);
        const options = { storeKey: identity.storeKey, lease, context };
        await writeMcpOAuthPendingAuthorization(options, "fixture-consume");
        expect(await readMcpOAuthPendingAuthorization("fixture-consume", context)).toBe(
          identity.storeKey,
        );
        expect(await consumeOAuthState(options, "fixture-consume")).toBe(true);
        expect(await consumeOAuthState(options, "fixture-consume")).toBe(false);
        await writeMcpOAuthPendingAuthorization(options, "fixture-delete");
        await deleteMcpOAuthPendingAuthorization(options);
        expect(await readMcpOAuthPendingAuthorization("fixture-delete", context)).toBeUndefined();
        await provider.invalidateCredentials?.("tokens");
        expect(await provider.tokens()).toBeUndefined();
        expect(await provider.clientInformation()).toEqual({ client_id: "fixture-client" });
        expect(await provider.codeVerifier()).toBe("fixture-verifier");
        await provider.saveTokens(tokens);
      });
      await closeOpenClawStateDatabaseAsync();
      await withMcpOAuthTestLease(identity.storeKey, async (lease, context) => {
        const provider = await createMcpOAuthClientProvider({
          identity,
          lease,
          storeContext: context,
        });
        expect(await provider.tokens()).toEqual(tokens);
        expect(await provider.discoveryState?.()).toEqual(discovery);
        expect(await provider.codeVerifier()).toBe("fixture-verifier");
        expect(provider.redirectUrl).toBe(redirectUrl);
        await clearMcpOAuthStore({ storeKey: identity.storeKey, lease, context });
        expect(await readMcpOAuthStore(identity.storeKey, context)).toEqual({
          credentialState: "cleared",
        });
        // Empty-prefix cleanup still obtains its own transaction and commit admission.
        await deleteMcpOAuthPendingAuthorizationsByPrefix(
          requesterMcpOAuthStoreKeyPrefix(identity.serverName, identity.serverUrl),
          context,
        );
      });
      await closeOpenClawStateDatabaseAsync();
      expect(
        Object.fromEntries(
          Object.entries(parentCalls).map(([name, spy]) => [name, spy.mock.calls.length]),
        ),
      ).toEqual({ prepare: 0, exec: 0, close: 0, get: 0, all: 0, run: 0, iterate: 0, wait: 0 });
    } finally {
      try {
        await closeOpenClawStateDatabaseAsync();
      } finally {
        for (const spy of Object.values(parentCalls)) {
          spy.mockRestore();
        }
      }
    }
  });
});
