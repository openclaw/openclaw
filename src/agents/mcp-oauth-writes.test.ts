import { expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { operatorMcpOAuthIdentity } from "./mcp-oauth-identity.js";
import { createMcpOAuthClientProvider } from "./mcp-oauth-provider.js";
import {
  clearMcpOAuthStore,
  deleteMcpOAuthPendingAuthorization,
  mutateMcpOAuthStore,
  readMcpOAuthPendingAuthorization,
  readMcpOAuthStore,
  writeMcpOAuthPendingAuthorization,
} from "./mcp-oauth-store.js";
import { withMcpOAuthTestLease } from "./mcp-oauth.test-support.js";

it("persists SDK callbacks and pending state across close without parent SQL or waits", async () => {
  await withOpenClawTestState({ label: "mcp-oauth-worker-writes" }, async () => {
    requireNodeSqlite();
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
    const sql = observeMainThreadSql({ includeClose: true });
    const wait = vi.spyOn(Atomics, "wait");
    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(() => {
      sql.restore();
      wait.mockRestore();
    });
    cleanup.defer(closeOpenClawStateDatabaseAsync);
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
    });
    await closeOpenClawStateDatabaseAsync();
    sql.expectIdle();
    expect(wait).not.toHaveBeenCalled();
  });
});

it("preserves transaction and commit authority when publishing credential writes", async () => {
  await withOpenClawTestState({ label: "mcp-oauth-write-authority" }, async () => {
    const identity = operatorMcpOAuthIdentity("write-authority", "https://mcp.example.test/rpc");
    await withMcpOAuthTestLease(identity.storeKey, async (lease, context) => {
      const options = { storeKey: identity.storeKey, lease, context };
      const mutation = {
        kind: "tokens" as const,
        tokens: { access_token: "fixture-access", token_type: "Bearer" },
        tokenExpiresAt: undefined,
      };
      for (const blocked of [true, false]) {
        const events: string[] = [];
        const writing = mutateMcpOAuthStore(options, mutation, {
          assertCurrent() {},
          beforeTransaction() {
            events.push("transaction");
            if (blocked) {
              throw new Error("fixture transaction authority retired");
            }
          },
          beforeCommit() {
            events.push("commit");
          },
        });
        if (blocked) {
          await expect(writing).rejects.toThrow("fixture transaction authority retired");
        } else {
          await writing;
        }
        expect(events).toEqual(blocked ? ["transaction"] : ["transaction", "commit"]);
        expect((await readMcpOAuthStore(identity.storeKey, context)).tokens).toEqual(
          blocked ? undefined : mutation.tokens,
        );
      }
    });
  });
});
