import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import * as config from "../../../config/config.js";
import { upsertSessionEntryCore } from "../../../config/sessions/session-accessor.js";
import { captureAgentTurnPrincipal } from "../../../gateway/agent-turn/principal.js";
import { captureGatewayAuthPolicy } from "../../../gateway/auth-policy.js";
import * as operatorCapture from "../../../gateway/operator-run-authority.js";
import * as operatorRecovery from "../../../gateway/operator-run-recovery.js";
import {
  createContext,
  createOperatorClient,
} from "../../../gateway/server-plugin-in-process-dispatch.test-support.js";
import { createMockGatewayRecoveryRuntime } from "../../../gateway/server-recovery-runtime.test-support.js";
import { rotateAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
import { WorkerTaskError } from "../../../infra/worker-task-pool.js";
import { createEmptyPluginRegistry } from "../../../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  stageActivePluginRegistry,
} from "../../../plugins/runtime.js";
import {
  getGatewayContextLifetime,
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../../../plugins/runtime/gateway-request-scope.js";
import { createPluginRecord } from "../../../plugins/status.test-helpers.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { createAdmittedRunOperatorAuthority } from "../../admitted-run-context.js";
import * as delivery from "../announce/subagent-announce-delivery.js";
import * as deliveryRuntime from "../announce/subagent-announce-delivery.runtime.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry-state.fixture.test-support.js";
import { observeRootWork } from "./subagent-registry.browser-cleanup.test-support.js";
import {
  activateSubagentRegistry,
  initSubagentRegistry,
  prepareRequesterSettleWakeRecoverySource,
  registerSubagentRun,
  replaceSubagentRunAfterSteerCore,
} from "./subagent-registry.js";
import { settleSubagentRegistryPersistenceWork } from "./subagent-registry.persistence.test-support.js";
import { preparePrivateReplay } from "./subagent-registry.private-input-replay.test-support.js";
import { registerRequesterAutomationCustodyTests } from "./subagent-registry.requester-automation-custody.test-support.js";
import { resetSubagentRegistryForTests, testing } from "./subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { buildRequesterSettleWakeIdentity } from "./subagent-requester-settle-identity.js";

type Registration = Parameters<typeof registerSubagentRun>[0];

export function registerRequesterCompletionCustodyTests({
  registration,
  updateRun,
}: {
  registration: (runId: string, overrides?: Partial<Registration>) => Registration;
  updateRun: (runId: string, update: (draft: SubagentRunRecord) => void) => Promise<void>;
}) {
  it.each([
    "current",
    "overloaded then current",
    "overloaded then revoked",
    "overloaded then retired",
    "unavailable policy then current",
    "revoked after restore",
    "missing source",
    "missing parent source",
    "mismatched source",
    "revoked grant",
    "mixed sources",
    "replaced requester",
  ] as const)(
    "revalidates %s for a cold-loaded interrupted child batch without widening the parent",
    async (recovery) => {
      const overloaded = recovery.startsWith("overloaded");
      const unavailablePolicy = recovery === "unavailable policy then current";
      const deferred = overloaded || unavailablePolicy;
      const terminalRecovery =
        recovery === "missing source" ||
        recovery === "missing parent source" ||
        recovery === "mismatched source" ||
        recovery === "revoked grant";
      const canDispatch =
        recovery === "current" || recovery === "overloaded then current" || unavailablePolicy;
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const cfg = { session: { store: state.path("sessions.json") } };
        config.setRuntimeConfigSnapshot(cfg);
        vi.mocked(config.getRuntimeConfig).mockReturnValue(cfg);
        const requesterSessionKey = "agent:main:main";
        const sessionId = "restart-requester";
        const lifecycleRevision = "restart-requester-lifecycle";
        const requesterTurnRunId = "restart-parent-turn";
        const runIds: [string, string] = ["restart-child-a", "restart-child-b"];
        const currentChild = (runId = runIds[0]) =>
          expectDefined(subagentRuns.get(runId), "restored child");
        await upsertSessionEntryCore(
          { storePath: cfg.session.store, sessionKey: requesterSessionKey, agentId: "main" },
          { sessionId, lifecycleRevision, updatedAt: 1 },
        );
        const context = createContext([], () => cfg);
        context.resolveGatewayContext = () => context;
        const client = createOperatorClient({
          profileName: "restart-requester",
          scopes: ["operator.admin"],
        });
        expectDefined(client.authenticatedUserProfile, "requester profile").displayName =
          "restart-requester";
        client.connect.client.id = "openclaw-control-ui";
        client.connect.client.mode = "webchat";
        client.internal = { authenticatedOperator: true, controlUiAdmin: true };
        client.authPolicy = captureGatewayAuthPolicy(cfg, {
          role: "operator",
          authMethod: "token",
        });
        const grantRef = { pluginId: "restart-access", grantId: "original-requester-grant" };
        let grantCurrent = true;
        let policyReady = true;
        const grant = {
          grantId: grantRef.grantId,
          signal: new AbortController().signal,
          assertCurrent: () => {
            if (!grantCurrent) {
              throw new Error("Original requester grant revoked");
            }
          },
        };
        const resumeGrant = vi.fn(({ grantId }: { grantId: string }) => {
          if (!policyReady) {
            throw new Error("Access policy is starting");
          }
          return grantCurrent && grantId === grantRef.grantId ? grant : undefined;
        });
        const registry = createEmptyPluginRegistry();
        registry.plugins.push(createPluginRecord({ id: grantRef.pluginId }));
        registry.gatewayAccessPolicies.push({
          pluginId: grantRef.pluginId,
          source: "fixture",
          policy: {
            authorize: () => (grantCurrent ? grant : undefined),
            resume: resumeGrant,
          },
        });
        const previousRegistry = captureActivePluginRegistrySnapshot();
        stageActivePluginRegistry(registry, null, "default");
        const source = expectDefined(
          await operatorCapture.captureGatewayOperatorRunAuthority({
            client: expectDefined(captureAgentTurnPrincipal(client), "authenticated requester"),
            context,
            sourceAuthority: { gatewayAccessGrant: grantRef, assertCurrent: grant.assertCurrent },
          }),
          "restart requester source",
        );
        const narrowed = createAdmittedRunOperatorAuthority({
          ...source.authority,
          scopes: ["operator.write"],
        });
        client.internal.operatorRunAuthority = narrowed;
        const resumeDelivery = createDeferredCore();
        const captureRequester = deliveryRuntime.captureRequesterSessionEntryCurrent;
        // Activation restores authority first; release the actual wake after each policy decision.
        const requesterRead = vi
          .spyOn(deliveryRuntime, "captureRequesterSessionEntryCurrent")
          .mockImplementation(async (...args) => {
            await resumeDelivery.promise;
            return captureRequester(...args);
          });
        let deliveredAuthority: ReturnType<typeof createAdmittedRunOperatorAuthority> | undefined;
        const deliver = vi
          .spyOn(delivery, "deliverSubagentAnnouncement")
          .mockImplementation(async (params) => {
            await params.onBeforeDispatch?.();
            deliveredAuthority =
              getPluginRuntimeGatewayRequestScope()?.client?.internal?.operatorRunAuthority;
            expectDefined(deliveredAuthority, "restored requester authority").assertCurrent();
            params.onAccepted?.({ status: "accepted" });
            return { delivered: true, path: "direct" };
          });
        const join = observeRootWork();
        try {
          await withPluginRuntimeGatewayRequestScope(
            {
              client,
              context,
              resolveGatewayContext: () => context,
              isWebchatConnect: () => false,
            },
            async () => {
              for (const runId of runIds) {
                await registerSubagentRun(
                  registration(runId, {
                    requesterSessionKey,
                    requesterAgentId: "main",
                    requesterTurnRunId,
                    completionTarget: "parent",
                    completionRequesterSessionId: sessionId,
                    completionRequesterLifecycleRevision: lifecycleRevision,
                    gatewayContextResolver: () => context,
                  }),
                );
              }
            },
          );
          for (const runId of runIds) {
            const admitted = loadSubagentRegistryFromSqlite().get(runId);
            expect(admitted?.operatorRecoverySource).toMatchObject({
              agentId: "main",
              sessionKey: requesterSessionKey,
              sessionId,
              lifecycleRevision,
              sourceRunId: requesterTurnRunId,
              snapshot: { scopes: ["operator.write"], grant: grantRef },
            });
            // Crash after interruption was recorded, before its parent continuation was dispatched.
            await updateRun(runId, (draft) => {
              const text = `${runId} interrupted by Gateway restart`;
              draft.execution = {
                ...draft.execution,
                status: "terminal",
                endedAt: Date.now(),
                outcome: { status: "error", error: "Gateway restarted" },
              };
              draft.completion = {
                required: true,
                resultText: text,
                terminalReply: { disposition: "visible", text },
              };
              draft.delivery = { status: "delivered" };
              draft.cleanupCompletedAt = Date.now();
              draft.requesterTurnRunId = undefined;
              draft.requesterSettleWake = {
                status: terminalRecovery || unavailablePolicy ? "dispatching" : "pending",
                attemptCount: terminalRecovery || unavailablePolicy ? 1 : 0,
                rearmGeneration: 1,
                batchRunIds: runIds,
                nextAttemptAt: Date.now() + 60_000,
              };
              if (recovery === "missing source") {
                delete draft.operatorRecoverySource;
              } else if (recovery === "mismatched source") {
                expectDefined(draft.operatorRecoverySource, "admitted source").sessionId =
                  "another-requester-session";
              } else if (recovery === "mixed sources" && runId === runIds[1]) {
                expectDefined(draft.operatorRecoverySource, "second admitted source").sourceRunId =
                  "another-requester-turn";
              }
            });
          }
          const stale = currentChild();
          const replay = await preparePrivateReplay(recovery === "current" ? stale : undefined);
          source.release();
          getGatewayContextLifetime(context.resolveGatewayContext).abort();
          await resetSubagentRegistryForTests({ persist: false });
          rotateAgentEventLifecycleGeneration();
          grantCurrent = recovery !== "revoked grant";
          policyReady = !unavailablePolicy;
          if (recovery === "replaced requester") {
            await upsertSessionEntryCore(
              { storePath: cfg.session.store, sessionKey: requesterSessionKey, agentId: "main" },
              {
                sessionId: "replacement-requester",
                lifecycleRevision: "replacement-lifecycle",
                updatedAt: 2,
              },
            );
          }
          const replacement = createContext([], () => cfg);
          replacement.resolveGatewayContext = () => replacement;
          replacement.recoveryRuntime = createMockGatewayRecoveryRuntime();
          const recoveryTarget = {
            ...buildRequesterSettleWakeIdentity({
              requesterSessionKey,
              requesterAgentId: "main",
              batchRunIds: runIds,
              rearmGeneration: 1,
            }),
            requesterSessionKey,
            requesterAgentId: "main",
            sessionId,
            lifecycleRevision,
            storePath: cfg.session.store,
            gatewayRuntime: replacement.recoveryRuntime,
            ...(recovery === "missing parent source"
              ? { requesterOperatorSourceMissing: true as const }
              : {}),
          };
          const prepareRecovery = () => prepareRequesterSettleWakeRecoverySource(recoveryTarget);
          if (overloaded) {
            vi.spyOn(operatorRecovery, "restoreGatewayOperatorSource").mockRejectedValueOnce(
              new WorkerTaskError("worker task capacity reached", "overloaded"),
            );
          }
          await initSubagentRegistry();
          if (terminalRecovery) {
            const unbound = loadSubagentRegistryFromSqlite();
            await expect(prepareRecovery()).rejects.toThrow("awaits its current Gateway binding");
            expect(loadSubagentRegistryFromSqlite()).toEqual(unbound);
          }
          await activateSubagentRegistry(() => replacement);
          await replay?.();
          if (terminalRecovery) {
            if (recovery === "missing source") {
              // Registry binding already settled the unavailable continuation.
              await expect(prepareRecovery()).resolves.toBeUndefined();
            } else {
              await expect(prepareRecovery()).resolves.toEqual({
                status: "unrestorable",
                reason: expect.stringMatching(/original operator/),
              });
            }
            const settled = loadSubagentRegistryFromSqlite();
            for (const runId of runIds) {
              expect(settled.get(runId)?.requesterSettleWake).toBeUndefined();
              expect(settled.get(runId)?.completion?.resultText).toBe(
                `${runId} interrupted by Gateway restart`,
              );
              expect(settled.get(runId)?.execution.outcome).toEqual({
                status: "error",
                error: "Gateway restarted",
              });
            }
            await expect(prepareRecovery()).resolves.toBeUndefined();
            expect(loadSubagentRegistryFromSqlite()).toEqual(settled);
            resumeDelivery.resolve();
            await join(true);
            getGatewayContextLifetime(replacement.resolveGatewayContext).abort();
            await resetSubagentRegistryForTests({ persist: false });
            rotateAgentEventLifecycleGeneration();
            await initSubagentRegistry();
            const nextGateway = createContext([], () => cfg);
            nextGateway.resolveGatewayContext = () => nextGateway;
            nextGateway.recoveryRuntime = createMockGatewayRecoveryRuntime();
            await activateSubagentRegistry(() => nextGateway);
            await expect(
              prepareRequesterSettleWakeRecoverySource({
                ...recoveryTarget,
                gatewayRuntime: nextGateway.recoveryRuntime,
              }),
            ).resolves.toBeUndefined();
            expect(loadSubagentRegistryFromSqlite()).toEqual(settled);
            expect(deliver).not.toHaveBeenCalled();
            return;
          }
          if (deferred) {
            const blockedEffect = vi.fn();
            expect(() =>
              subagentRuns.runWithCompletionAuthority(currentChild(), blockedEffect),
            ).toThrow(/authority/);
            expect(blockedEffect).not.toHaveBeenCalled();
            expect(deliver).not.toHaveBeenCalled();
            if (unavailablePolicy) {
              const pending = loadSubagentRegistryFromSqlite();
              await expect(prepareRecovery()).rejects.toThrow(/authority/);
              expect(loadSubagentRegistryFromSqlite()).toEqual(pending);
              policyReady = true;
            }
            grantCurrent = recovery !== "overloaded then revoked";
            if (recovery === "overloaded then retired") {
              subagentRuns.retireCompletionAuthority(currentChild());
            }
            // The same Gateway retries admitted inventory; no process restart or rebinding.
            await testing.sweepOnceForTests();
            if (unavailablePolicy) {
              const prepared = await prepareRecovery();
              expect(prepared?.status).toBe("ready");
              if (prepared?.status === "ready") {
                expect(prepared.source).not.toThrow();
              }
            }
          }
          if (canDispatch || recovery === "mixed sources" || recovery === "revoked after restore") {
            for (const runId of runIds) {
              expect(
                () => subagentRuns.runWithCompletionAuthority(currentChild(runId), () => {}),
                `immediately after activation: ${runId}`,
              ).not.toThrow();
            }
          }
          if (recovery === "revoked after restore") {
            grantCurrent = false;
          }
          if (deferred || recovery === "revoked after restore") {
            const resumedGrants = resumeGrant.mock.calls.length;
            await testing.sweepOnceForTests();
            expect(resumeGrant).toHaveBeenCalledTimes(resumedGrants);
          }
          if (recovery !== "replaced requester") {
            expect(resumeGrant).toHaveBeenCalledWith(
              expect.objectContaining({ grantId: grantRef.grantId }),
            );
          }
          const staleEffect = vi.fn();
          expect(() => subagentRuns.runWithCompletionAuthority(stale, staleEffect)).toThrow(
            /authority|owner/,
          );
          expect(staleEffect).not.toHaveBeenCalled();
          if (!canDispatch && recovery !== "mixed sources") {
            expect(() =>
              subagentRuns.runWithCompletionAuthority(currentChild(), staleEffect),
            ).toThrow(
              recovery === "revoked after restore"
                ? /access policy is unavailable/
                : recovery === "overloaded then retired"
                  ? /requester store was retired/
                  : /authority/,
            );
            expect(staleEffect).not.toHaveBeenCalled();
          }
          expect(source.authority.assertCurrent).toThrow();
          // The policy checks above retain the saved backoff; now make the wake due.
          for (const runId of runIds) {
            await updateRun(runId, (draft) => {
              if (draft.requesterSettleWake) {
                draft.requesterSettleWake.nextAttemptAt = undefined;
              }
            });
          }
          await testing.sweepOnceForTests();
          resumeDelivery.resolve();
          await join(true);
          await settleSubagentRegistryPersistenceWork();
          const settled = loadSubagentRegistryFromSqlite();
          expect(deliver).toHaveBeenCalledTimes(canDispatch ? 1 : 0);
          if (canDispatch) {
            expect(deliver).toHaveResolvedTimes(1);
            expect(deliveredAuthority?.profileId).toBe(source.authority.profileId);
            expect(deliveredAuthority?.scopes).toEqual(["operator.write"]);
            expect(deliveredAuthority?.gatewayAccessGrant).toEqual(grantRef);
            // Committed batch settlement releases its restored completion custody.
            expect(deliveredAuthority?.assertCurrent).toThrow(/authority/);
            const message = deliver.mock.calls[0]?.[0].triggerMessage;
            expect(message).toContain("restart-child-a interrupted by Gateway restart");
            expect(message).toContain("restart-child-b interrupted by Gateway restart");
          }
          for (const runId of runIds) {
            const entry = settled.get(runId);
            if (canDispatch) {
              expect(entry?.requesterSettleWake).toBeUndefined();
            }
            expect(entry?.completion?.resultText).toBe(`${runId} interrupted by Gateway restart`);
          }
          if (recovery === "current") {
            const completed = currentChild();
            expect(
              await replaceSubagentRunAfterSteerCore({
                previousRunId: completed.runId,
                nextRunId: "fresh-child-task",
                expected: completed,
                allowEndedSource: true,
                preserveCompletedRun: true,
                gatewayContextResolver: () => replacement,
              }),
            ).toBe(true);
            const persisted = loadSubagentRegistryFromSqlite();
            expect(persisted.get(completed.runId)?.operatorRecoverySource).toBeDefined();
            expect(persisted.get("fresh-child-task")?.operatorRecoverySource).toBeUndefined();
          }
        } finally {
          resumeDelivery.resolve();
          await join();
          requesterRead.mockRestore();
          if (overloaded) {
            vi.mocked(operatorRecovery.restoreGatewayOperatorSource).mockRestore();
          }
          deliver.mockRestore();
          source.release();
          await resetSubagentRegistryForTests({ persist: false });
          await settleSubagentRegistryPersistenceWork();
          restoreActivePluginRegistrySnapshot(previousRegistry);
        }
      });
    },
  );

  registerRequesterAutomationCustodyTests({ registration, updateRun });
}
