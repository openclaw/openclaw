import { expect, it, vi } from "vitest";
import { GatewayClientRequestError } from "../../../../packages/gateway-client/src/request-error.js";
import {
  validateSessionsDeleteParams,
  type SessionsDeleteParams,
} from "../../../../packages/gateway-protocol/src/index.js";
import { getRuntimeConfig } from "../../../config/config.js";
import { loadSessionEntryReadOnly } from "../../../config/sessions/session-accessor.js";
import type { callGateway } from "../../../gateway/call.js";
import { createChatRunState } from "../../../gateway/server-chat-state.js";
import { createContext } from "../../../gateway/server-plugin-in-process-dispatch.test-support.js";
import {
  withPluginRuntimeGatewayRequestScope,
  getGatewayContextResolver,
} from "../../../plugins/runtime/gateway-request-scope.js";
import { openOpenClawAgentDatabase } from "../../../state/openclaw-agent-db.js";
import * as stateWorker from "../../../state/openclaw-state-worker-store.js";
import { isSubagentRegistryWriteCommand } from "../../subagent-test-fixtures.test-helpers.js";
import {
  runSubagentStateWorkerOperation,
  type useSubagentControlFixture,
} from "./subagent-control.test-support.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { writeSubagentSessionEntry } from "./subagent-registry.persistence.test-support.js";
import {
  parseSubagentRegistryWriteReceipt,
  rowToSubagentRunRecord,
} from "./subagent-registry.store.codec.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry.store.sqlite.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const nativeSessionsDelete = await vi.importActual<
  typeof import("../../../gateway/server-methods/sessions-delete.js")
>("../../../gateway/server-methods/sessions-delete.js");

export function createSuspendedDeleteNativeFixture(
  fixture: ReturnType<typeof useSubagentControlFixture>,
) {
  const originalPhysicalTarget = {
    sessionId: "ordinary-child-session",
    lifecycleRevision: "ordinary-child-revision",
  };

  function nativeChildScope(sessionKey: string) {
    return {
      agentId: "main",
      env: { OPENCLAW_STATE_DIR: fixture.stateDir },
      sessionKey,
    };
  }

  function readNativeChildNode(sessionKey: string) {
    // The child lives in agent SQLite, NOT the shared-state registry database.
    // This is a native SELECT; no fixture deletion, UPDATE, or CAS implementation.
    return openOpenClawAgentDatabase(nativeChildScope(sessionKey))
      .db.prepare("SELECT current_session_id, entry_json FROM session_nodes WHERE session_key = ?")
      .get(sessionKey);
  }

  function installOwnedNativeDeleteGateway() {
    const context = createContext();
    context.localEmbedded = true;
    context.getRuntimeConfig = getRuntimeConfig;
    context.chatAbortControllers = new Map();
    context.chatQueuedTurns = new Map();
    context.agentRunSeq = new Map();
    context.chatRunState = createChatRunState();
    context.removeChatRun = context.chatRunState.registry.remove;
    context.broadcast = vi.fn();
    context.broadcastToConnIds = vi.fn();
    context.nodeSendToSession = vi.fn();
    context.getSessionEventSubscriberConnIds = () => new Set<string>();
    const resolveGatewayContext = () => context;
    context.resolveGatewayContext = resolveGatewayContext;

    const requests: SessionsDeleteParams[] = [];
    const outcomes: Awaited<ReturnType<typeof nativeSessionsDelete.deleteGatewaySession>>[] = [];
    let beforeDelete: (() => Promise<void>) | undefined;

    // Preserve callGateway's generic function signature. Cast only the concrete reply,
    // after method/schema narrowing, as the fixture transport's caller-selected T.
    fixture.gateway.mockImplementation(
      async <T>(request: Parameters<typeof callGateway>[0]): Promise<T> => {
        if (request.method === "agent.wait") {
          return await new Promise<never>(() => {}); // retain the existing fixture behavior
        }
        if (request.method !== "sessions.delete" || !validateSessionsDeleteParams(request.params)) {
          throw new Error(`Unexpected or invalid native deletion fixture RPC: ${request.method}`);
        }
        const params = structuredClone(request.params);
        return await context.trackExecution(async () => {
          await request.prepareDispatchCurrent?.();
          request.assertDispatchCurrent?.();
          requests.push(params);
          const hook = beforeDelete;
          beforeDelete = undefined;
          await hook?.();
          request.assertDispatchCurrent?.();
          const result = await nativeSessionsDelete.deleteGatewaySession({
            params,
            client: null,
            context,
            assertCurrent: request.assertDispatchCurrent,
          });
          outcomes.push(result);
          if (!result.ok) {
            // Preserve the official gatewayCode/details contract used to recognize changed ownership.
            throw new GatewayClientRequestError(result.error);
          }
          // SAFETY: sessions.delete schema was validated and its actual owner produced this reply.
          // This narrow test adapter is the only implementation of the generic transport here.
          return result.result as T;
        });
      },
    );
    return {
      context,
      resolveGatewayContext,
      requests,
      outcomes,
      beforeNextDelete(hook: () => Promise<void>) {
        beforeDelete = hook;
      },
      inScope<T>(run: () => T): T {
        return withPluginRuntimeGatewayRequestScope(
          { context, resolveGatewayContext, isWebchatConnect: () => false },
          run,
        );
      },
    };
  }

  function observeCleanupBookkeepingInput(runId: string, assertBeforeWrite: () => void) {
    let count = 0;
    const spy = vi
      .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
      .mockImplementation((stateContext, operation, options) =>
        runSubagentStateWorkerOperation(
          stateContext,
          (scope) =>
            operation({
              async execute(command, executeOptions) {
                let completedAt: number | undefined;
                if (isSubagentRegistryWriteCommand(command)) {
                  const row = command.input.values.find((value) => value.run_id === runId);
                  if (row && typeof row.payload_json === "string") {
                    const postimage = rowToSubagentRunRecord(row);
                    if (typeof postimage?.cleanupCompletedAt === "number") {
                      completedAt = postimage.cleanupCompletedAt;
                      assertBeforeWrite();
                    }
                  }
                }
                // Forward the original correlated command and options to the native worker.
                // Never synthesize versions/ACK or execute the command a second time.
                const result = await scope.execute(command, executeOptions);
                if (completedAt !== undefined && isSubagentRegistryWriteCommand(command)) {
                  const receipt = parseSubagentRegistryWriteReceipt(result, command.input);
                  const nativeEntry = loadSubagentRegistryFromSqlite().get(runId);
                  expect(nativeEntry).toBeDefined();
                  if ("conflictRunIds" in receipt) {
                    expect(receipt.conflictRunIds).toContain(runId);
                    expect(nativeEntry?.cleanupCompletedAt).toBeUndefined();
                  } else {
                    expect(receipt.versions.get(runId)).toEqual(expect.any(String));
                    expect(nativeEntry?.cleanupCompletedAt).toBe(completedAt);
                    count++;
                  }
                }
                return result;
              },
            }),
          options,
        ),
      );
    return {
      get count() {
        return count;
      },
      restore: () => spy.mockRestore(),
    };
  }

  function defineNativeCases(params: {
    testing: (typeof import("./subagent-registry.test-helpers.js"))["testing"];
    registerCompletion: (
      runId: string,
      options: {
        cleanup: "delete";
        holdForRequester: true;
        originalSessionIdentity?: typeof originalPhysicalTarget;
        gatewayContextResolver: Parameters<
          (typeof import("./subagent-registry.js"))["registerSubagentRun"]
        >[0]["gatewayContextResolver"];
      },
    ) => Promise<{ runId: string; childSessionKey: string }>;
    completeRegistered: (run: { runId: string; childSessionKey: string }) => void;
    updateRun: (runId: string, edit: (draft: SubagentRunRecord) => void) => Promise<void>;
  }) {
    const { testing, registerCompletion, completeRegistered, updateRun } = params;
    it.each([
      "original",
      "same-key-successor",
      "failed-then-retry",
      "legacy-no-identity",
      "legacy-stamp-only",
    ] as const)(
      "deletes or fences an expired suspended child before retained bookkeeping (%s)",
      async (mode) => {
        const legacy = mode === "legacy-no-identity" || mode === "legacy-stamp-only";
        const legacyStamp = Date.now() - 10_000;
        const gateway = installOwnedNativeDeleteGateway();
        const run = await gateway.inScope(() =>
          registerCompletion(`suspended-native-${mode}`, {
            cleanup: "delete",
            holdForRequester: true,
            originalSessionIdentity: legacy ? undefined : originalPhysicalTarget,
            gatewayContextResolver: gateway.resolveGatewayContext,
          }),
        );
        completeRegistered(run);
        await fixture.settle();
        expect(loadSessionEntryReadOnly(nativeChildScope(run.childSessionKey))).toMatchObject(
          originalPhysicalTarget,
        );
        const originalNode = readNativeChildNode(run.childSessionKey);
        expect(originalNode).toBeDefined();
        const archiveAtMs = subagentRuns.get(run.runId)!.archiveAtMs;
        if (archiveAtMs === undefined) throw new Error("Expected original archive deadline");
        expect(archiveAtMs).toBeGreaterThan(Date.now());
        await updateRun(run.runId, (draft) => {
          if (mode === "legacy-stamp-only") draft.deleteCleanupDispatchedAt = legacyStamp;
          draft.delivery = {
            ...draft.delivery,
            status: "suspended",
            suspendedAt: Date.now() - 8 * 24 * 60 * 60_000,
            suspendedReason: "expiry",
          };
        });

        let successorNode: ReturnType<typeof readNativeChildNode>;
        if (mode === "same-key-successor") {
          // Introduce the race AFTER the dispatch guard/capture, before the real physical owner checks.
          // A successor written earlier might be suppressed before RPC and would not prove server CAS.
          gateway.beforeNextDelete(async () => {
            expect(gateway.requests.at(-1)).toMatchObject({
              expectedSessionId: originalPhysicalTarget.sessionId,
              expectedLifecycleRevision: originalPhysicalTarget.lifecycleRevision,
            });
            await writeSubagentSessionEntry({
              stateDir: fixture.stateDir,
              agentId: "main",
              sessionKey: run.childSessionKey,
              defaultSessionId: "successor-child-session",
              sessionId: "successor-child-session",
              lifecycleRevision: "successor-child-revision",
            });
            successorNode = readNativeChildNode(run.childSessionKey);
            expect(successorNode).toBeDefined();
          });
        }
        if (mode === "failed-then-retry") {
          gateway.beforeNextDelete(async () => {
            throw new Error("owned pre-delete transport fault");
          });
        }

        const bookkeeping = observeCleanupBookkeepingInput(run.runId, () => {
          // This callback runs BEFORE the actual native bookkeeping B transaction.
          const nativeEntry = loadSubagentRegistryFromSqlite().get(run.runId);
          expect(nativeEntry).toMatchObject({
            runId: run.runId,
            generation: subagentRuns.get(run.runId)!.generation,
            createdAt: subagentRuns.get(run.runId)!.createdAt,
            childSessionKey: run.childSessionKey,
            delivery: { status: "suspended" },
          });
          expect(nativeEntry?.cleanupCompletedAt).toBeUndefined();
          if (legacy) {
            expect(gateway.requests).toHaveLength(0);
            expect(gateway.outcomes).toHaveLength(0);
            expect(readNativeChildNode(run.childSessionKey)).toEqual(originalNode);
            expect(loadSessionEntryReadOnly(nativeChildScope(run.childSessionKey))).toMatchObject(
              originalPhysicalTarget,
            );
          } else if (mode === "same-key-successor") {
            expect(gateway.outcomes).toHaveLength(1);
            expect(gateway.outcomes[0]).toMatchObject({
              ok: false,
              error: { code: "INVALID_REQUEST", details: { reason: "session-changed" } },
            });
            expect(readNativeChildNode(run.childSessionKey)).toEqual(successorNode);
            expect(loadSessionEntryReadOnly(nativeChildScope(run.childSessionKey))).toMatchObject({
              sessionId: "successor-child-session",
              lifecycleRevision: "successor-child-revision",
            });
          } else {
            expect(gateway.outcomes).toHaveLength(1);
            expect(gateway.outcomes[0]).toMatchObject({ ok: true, result: { deleted: true } });
            expect(readNativeChildNode(run.childSessionKey)).toBeUndefined();
            expect(loadSessionEntryReadOnly(nativeChildScope(run.childSessionKey))).toBeUndefined();
          }
        });
        try {
          if (mode === "failed-then-retry") {
            // Use the actual canonical delete-cleanup rejection, not a mocked bookkeeping rejection.
            await expect(testing.sweepOnceForTests()).rejects.toThrow(
              "subagent session cleanup did not complete",
            );
            await fixture.settle();
            expect(bookkeeping.count).toBe(0);
            expect(gateway.outcomes).toHaveLength(0); // owner never ran on injected failure
            expect(loadSessionEntryReadOnly(nativeChildScope(run.childSessionKey))).toMatchObject(
              originalPhysicalTarget,
            );
            expect(readNativeChildNode(run.childSessionKey)).toBeDefined();
            expect(subagentRuns.get(run.runId)).toMatchObject({
              archiveAtMs,
              delivery: { status: "suspended" },
              deleteCleanupTarget: originalPhysicalTarget,
              deleteCleanupDispatchedAt: expect.any(Number),
            });
            expect(subagentRuns.get(run.runId)?.cleanupCompletedAt).toBeUndefined();
            expect(getGatewayContextResolver(subagentRuns.get(run.runId)!)).toBe(
              gateway.resolveGatewayContext,
            );
            expect(loadSubagentRegistryFromSqlite().get(run.runId)).toMatchObject({
              archiveAtMs,
              delivery: { status: "suspended" },
              deleteCleanupTarget: originalPhysicalTarget,
            });
          }
          await testing.sweepOnceForTests();
          await fixture.settle();
          expect(bookkeeping.count).toBe(1);
          expect(gateway.requests).toHaveLength(legacy ? 0 : mode === "failed-then-retry" ? 2 : 1);
          for (const request of gateway.requests) {
            expect(request).toEqual({
              key: run.childSessionKey,
              deleteTranscript: true,
              emitLifecycleHooks: false,
              expectedSessionId: originalPhysicalTarget.sessionId,
              expectedLifecycleRevision: originalPhysicalTarget.lifecycleRevision,
            });
          }
          const retained = subagentRuns.get(run.runId)!;
          expect(retained).toMatchObject({
            archiveAtMs,
            delivery: { status: "discarded" },
            cleanupCompletedAt: expect.any(Number),
          });
          expect(retained.requesterSettleWake).toBeUndefined();
          expect(loadSubagentRegistryFromSqlite().get(run.runId)).toMatchObject({
            archiveAtMs,
            delivery: { status: "discarded" },
            cleanupCompletedAt: retained.cleanupCompletedAt,
          });
          expect(getGatewayContextResolver(retained)).toBeUndefined();
          if (legacy) {
            expect(retained.deleteCleanupTarget).toBeUndefined();
            expect(retained.childSessionIdentity).toBeUndefined();
            expect(retained.deleteCleanupDispatchedAt).toBe(
              mode === "legacy-stamp-only" ? legacyStamp : undefined,
            );
            expect(readNativeChildNode(run.childSessionKey)).toEqual(originalNode);
          } else if (mode !== "same-key-successor") {
            expect(retained).toMatchObject({
              deleteCleanupTarget: originalPhysicalTarget,
              deleteCleanupDispatchedAt: expect.any(Number),
            });
          }
          if (mode === "same-key-successor" || legacy) {
            expect(retained.execution.suppressSessionEffects).toBe(true);
            expect(
              loadSubagentRegistryFromSqlite().get(run.runId)?.execution.suppressSessionEffects,
            ).toBe(true);
            // Current canonical ownership-changed suppression clears target/stamp: do not demand them here.
          }
          bookkeeping.restore(); // later archive must not count as the initial bookkeeping B
          await testing.sweepOnceForTests();
          await fixture.settle();
          expect(gateway.requests).toHaveLength(legacy ? 0 : mode === "failed-then-retry" ? 2 : 1);
          expect(subagentRuns.get(run.runId)?.cleanupCompletedAt).toBe(retained.cleanupCompletedAt);
          expect(loadSubagentRegistryFromSqlite().has(run.runId)).toBe(true);
          const clock = vi.spyOn(Date, "now").mockReturnValue(archiveAtMs);
          try {
            await testing.sweepOnceForTests();
            await fixture.settle();
            expect(subagentRuns.has(run.runId)).toBe(false);
            expect(loadSubagentRegistryFromSqlite().has(run.runId)).toBe(false);
            if (mode === "same-key-successor")
              expect(readNativeChildNode(run.childSessionKey)).toEqual(successorNode);
            else if (legacy) expect(readNativeChildNode(run.childSessionKey)).toEqual(originalNode);
            else expect(readNativeChildNode(run.childSessionKey)).toBeUndefined();
            expect(gateway.requests).toHaveLength(
              legacy ? 0 : mode === "failed-then-retry" ? 2 : 1,
            );
          } finally {
            clock.mockRestore();
          }
        } finally {
          bookkeeping.restore();
        }
      },
    );
  }
  return {
    originalPhysicalTarget,
    readNativeChildNode,
    installOwnedNativeDeleteGateway,
    defineNativeCases,
  };
}
