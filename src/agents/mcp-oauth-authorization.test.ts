import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import type { SqliteWorkerOperationSettlement } from "../infra/sqlite-worker-operation-settlement.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import type { OpenClawStateAsyncLeaseContext } from "../state/openclaw-state-lease-context.js";
import { createOpenClawStateLeaseWorkerOwner } from "../state/openclaw-state-lease-worker-owner.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { McpConnectionAuthorityError } from "./mcp-connection-authority-error.js";
import { captureMcpOAuthAuthorization } from "./mcp-oauth-authorization.js";
import { requesterMcpOAuthIdentity } from "./mcp-oauth-identity.js";
import { createMcpOAuthClientProvider } from "./mcp-oauth-provider.js";
import { retainMcpOAuthAuthorizationState } from "./mcp-oauth-store.authorization.js";
import * as oauthStore from "./mcp-oauth-store.js";
import {
  clearMcpOAuthStore,
  mutateMcpOAuthStore,
  readMcpOAuthStoreReadOnly,
} from "./mcp-oauth-store.js";
import type { McpOAuthMutation } from "./mcp-oauth-store.types.js";
import { recordMcpOAuthAuthorizationRequired } from "./mcp-oauth.js";
import { seedMcpOAuthStoreForTest, withMcpOAuthTestLease } from "./mcp-oauth.test-support.js";

const identity = requesterMcpOAuthIdentity("events", "https://mcp.example.test/events", {
  messageChannel: "discord",
  agentAccountId: "fixture-bot",
  requesterSenderId: "fixture-requester",
});
const tokens = {
  access_token: "fixture-access",
  refresh_token: "fixture-refresh",
  token_type: "Bearer",
};
const retired = new McpConnectionAuthorityError("retired");
const unavailable = new McpConnectionAuthorityError("unavailable");
const capture = () => captureMcpOAuthAuthorization({ identity, assertCurrent() {} });
const mutate = (mutation: McpOAuthMutation) =>
  withMcpOAuthTestLease(identity.storeKey, (lease, context) =>
    mutateMcpOAuthStore({ storeKey: identity.storeKey, lease, context }, mutation),
  );
const save = () => mutate({ kind: "tokens", tokens, tokenExpiresAt: undefined });
const clear = () =>
  withMcpOAuthTestLease(identity.storeKey, (lease, context) =>
    clearMcpOAuthStore({ storeKey: identity.storeKey, lease, context }),
  );

it("binds legacy requester grants, preserves refresh, and never revives logout or replacement handles", async () => {
  await withOpenClawTestState({ label: "mcp-oauth-authorization" }, async () => {
    await expect(capture()).rejects.toThrow(retired);
    seedMcpOAuthStoreForTest(identity.storeKey, {
      tokens: { access_token: "fixture-expired", token_type: "Bearer" },
      tokenExpiresAt: Date.now() - 1,
    });
    await expect(capture()).rejects.toThrow(retired);
    seedMcpOAuthStoreForTest(identity.storeKey, { tokens });
    const sql = observeMainThreadSql();
    const retained: Awaited<ReturnType<typeof capture>>[] = [];
    const keep = async () => {
      const handle = await capture();
      retained.push(handle);
      return handle;
    };
    try {
      const original = await keep();
      expect((await readMcpOAuthStoreReadOnly(identity.storeKey)).authorizationId).toBe(
        original.authorizationId,
      );
      expect(original.authorizationId).not.toContain(tokens.access_token);
      expect((await keep()).authorizationId).toBe(original.authorizationId);
      await withMcpOAuthTestLease(identity.storeKey, async (lease, context) => {
        const provider = await createMcpOAuthClientProvider({
          identity,
          lease,
          storeContext: context,
        });
        await provider.saveTokens({ ...tokens, access_token: "fixture-refreshed" });
        // Verification inside an existing flow cannot reacquire its own lease.
        const insideFlow = await capture();
        expect(insideFlow.authorizationId).toBe(original.authorizationId);
        insideFlow.dispose();
      });
      await original.revalidate();
      expect(original.assertCurrent).not.toThrow();
      const readFailure = vi
        .spyOn(oauthStore, "readMcpOAuthStoreReadOnly")
        .mockRejectedValueOnce(new Error("fixture diagnostic must stay private"));
      try {
        await expect(original.revalidate()).rejects.toThrow(unavailable);
        expect(original.assertCurrent).toThrow(unavailable);
      } finally {
        readFailure.mockRestore();
      }
      await original.revalidate();
      expect(original.assertCurrent).not.toThrow();
      expect(
        await recordMcpOAuthAuthorizationRequired({
          identity,
          rejectedAccessToken: tokens.access_token,
        }),
      ).toBe(false);
      // The canonical writer's CAS also leaves stale challenges inert.
      expect(
        (
          await mutate({
            kind: "authorizationChallenge",
            rejectedAccessToken: tokens.access_token,
            requiresAuthorization: true,
          })
        ).applied,
      ).toBe(false);
      expect(original.assertCurrent).not.toThrow();
      expect(
        await recordMcpOAuthAuthorizationRequired({
          identity,
          rejectedAccessToken: "fixture-refreshed",
        }),
      ).toBe(true);
      expect(original.assertCurrent).toThrow(retired);
      await expect(capture()).rejects.toThrow(retired);
      await save();
      const reconnected = await keep();
      expect(reconnected.authorizationId).not.toBe(original.authorizationId);
      expect(original.assertCurrent).toThrow(retired);
      await withMcpOAuthTestLease(identity.storeKey, async (lease, context) => {
        const replacement = await createMcpOAuthClientProvider({
          identity,
          lease,
          storeContext: context,
          replaceAuthorization: true,
        });
        // Even identical credentials for the same native requester are a new login.
        await replacement.saveTokens(tokens);
      });
      expect(reconnected.assertCurrent).toThrow(retired);
      const replaced = await keep();
      expect(replaced.authorizationId).not.toBe(reconnected.authorizationId);
      await clear();
      expect(replaced.assertCurrent).toThrow(retired);
      await save();
      const afterLogout = await keep();
      expect(afterLogout.authorizationId).not.toBe(replaced.authorizationId);
      expect(replaced.assertCurrent).toThrow(retired);
      const disposed = await keep();
      disposed.dispose();
      disposed.dispose();
      expect(disposed.assertCurrent).toThrow(retired);
      sql.expectIdle();
      await closeOpenClawStateDatabaseAsync();
      // Explicit test teardown checkpoints the old host database; capture itself must stay worker-only.
      sql.clear();
      expect(afterLogout.assertCurrent).toThrow(retired);
      const reopened = await keep();
      expect(reopened.authorizationId).toBe(afterLogout.authorizationId);
      expect(afterLogout.assertCurrent).toThrow(retired);
      sql.expectIdle();
    } finally {
      for (const handle of retained) {
        handle.dispose();
      }
      sql.restore();
    }
  });
});

it("fences before the actual commit grant and restores authority only after a known rollback", async () => {
  await withOpenClawTestState({ label: "mcp-oauth-authority-grant" }, async () => {
    await save();
    const retained = await capture();
    const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
    let refuse = true;
    let grants = 0;
    const spy = vi
      .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
      .mockImplementation((admit, attachment) =>
        createAdmission((request, grant) => {
          if (
            request.stage === "commit" &&
            isRecord(request.facts) &&
            request.facts.kind === "state-lease" &&
            isRecord(request.facts.identity) &&
            request.facts.identity.key === identity.storeKey
          ) {
            admit(request, () => {
              grants++;
              expect(retained.assertCurrent).toThrow(unavailable);
              if (refuse) {
                throw new Error("fixture commit refused");
              }
              return grant();
            });
          } else {
            admit(request, grant);
          }
        }, attachment),
      );
    try {
      await expect(clear()).rejects.toThrow("fixture commit refused");
      expect(grants).toBe(1);
      expect(retained.assertCurrent).not.toThrow();
      await retained.revalidate();
      refuse = false;
      await clear();
      expect(grants).toBe(2);
      expect(retained.assertCurrent).toThrow(retired);
    } finally {
      spy.mockRestore();
      retained.dispose();
    }
  });
});

it("reads foreign credential changes and refuses pending or uncertain owner facts", async () => {
  await withOpenClawTestState({ label: "mcp-oauth-authority-foreign" }, async () => {
    // Test-only native writes stand in for another process: no host publication is emitted.
    seedMcpOAuthStoreForTest(identity.storeKey, {
      tokens,
      authorizationId: "fixture-foreign-original",
    });
    const retained = await capture();
    try {
      seedMcpOAuthStoreForTest(identity.storeKey, {
        tokens,
        authorizationId: "fixture-foreign-reconnected",
      });
      expect(retained.assertCurrent).not.toThrow();
      await expect(retained.revalidate()).rejects.toThrow(retired);
      expect(retained.assertCurrent).toThrow(retired);
      const current = await capture();
      const context = captureOpenClawStateWorkerContext();
      const writer = retainMcpOAuthAuthorizationState(context.admission, identity.storeKey);
      try {
        const staleRead = writer.prepareRead();
        const rollback = writer.fence();
        expect(current.assertCurrent).toThrow(unavailable);
        await expect(current.revalidate()).rejects.toThrow(unavailable);
        rollback(true);
        expect(current.assertCurrent).not.toThrow();
        expect(() => staleRead({ authorizationId: current.authorizationId })).toThrow(unavailable);
        const uncertain = writer.fence();
        uncertain(false);
        expect(current.assertCurrent).toThrow(unavailable);
        await expect(current.revalidate()).rejects.toThrow(unavailable);
        await expect(capture()).rejects.toThrow(unavailable);
        // A later known refresh cannot certify an earlier unknown native outcome.
        writer.fence()(true, { authorizationId: current.authorizationId });
        expect(current.assertCurrent).toThrow(unavailable);
      } finally {
        writer.release();
        current.dispose();
      }
    } finally {
      retained.dispose();
    }
  });
});

it("retains the canonical clear fence when native settlement is unknown despite result failure", async () => {
  await withOpenClawTestState({ label: "mcp-oauth-authority-unknown" }, async () => {
    seedMcpOAuthStoreForTest(identity.storeKey, { tokens, authorizationId: "fixture-unknown" });
    const retained = await capture();
    const context = captureOpenClawStateWorkerContext();
    const lease: OpenClawStateAsyncLeaseContext = {
      signal: new AbortController().signal,
      async assertOwned() {},
      async renew() {},
    };
    const leaseIdentity = {
      scope: "core:mcp-oauth",
      key: identity.storeKey,
      owner: "fixture-owner",
    };
    const nativeOwner = createOpenClawStateLeaseWorkerOwner({
      lease,
      identity: leaseIdentity,
      databasePath: context.admission.databasePath,
      assertCurrent() {},
    });
    const settlement = createDeferredCore<SqliteWorkerOperationSettlement>();
    const deliveryError = new Error("fixture native result lost");
    const spy = vi
      .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
      .mockImplementation(async (_context, _operation, options) => {
        if (!options?.createAdmission) {
          throw new Error("Expected canonical lease admission");
        }
        const { admission } = options.createAdmission({ settled: settlement.promise });
        try {
          for (const stage of ["transaction", "commit"] as const) {
            const decision = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
            admission.port.postMessage(
              {
                stage,
                decision: decision.buffer,
                facts: {
                  kind: "state-lease",
                  identity: leaseIdentity,
                  expiresAt: Date.now() + 60_000,
                },
              },
              [],
            );
            admission.service();
            expect(Atomics.load(decision, 0)).toBe(1);
          }
          expect(retained.assertCurrent).toThrow(unavailable);
          settlement.resolve({ kind: "unknown", error: deliveryError });
          await settlement.promise;
          throw deliveryError;
        } finally {
          admission.finish();
        }
      });
    try {
      await expect(
        clearMcpOAuthStore({ storeKey: identity.storeKey, lease, context }),
      ).rejects.toMatchObject({ code: "outcome-unknown" });
      expect(retained.assertCurrent).toThrow(unavailable);
      await expect(retained.revalidate()).rejects.toThrow(unavailable);
    } finally {
      spy.mockRestore();
      settlement.resolve({ kind: "unknown", error: deliveryError });
      await expect(nativeOwner.drain()).rejects.toMatchObject({ code: "outcome-unknown" });
      nativeOwner.close();
      retained.dispose();
    }
  });
});
