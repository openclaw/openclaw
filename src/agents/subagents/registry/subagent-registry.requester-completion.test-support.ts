import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import * as config from "../../../config/config.js";
import { upsertSessionEntryCore } from "../../../config/sessions/session-accessor.js";
import { captureAgentTurnPrincipal } from "../../../gateway/agent-turn/principal.js";
import { captureGatewayAuthPolicy } from "../../../gateway/auth-policy.js";
import * as operatorCapture from "../../../gateway/operator-run-authority.js";
import * as operatorRecovery from "../../../gateway/operator-run-recovery.js";
import {
  resolveGatewayChatCronCreatorAuthorityAdmission,
  resolveGatewayCronCreatorAuthorityAdmission,
} from "../../../gateway/server-methods/cron-creator-authority-admission.js";
import {
  createContext,
  createOperatorClient,
} from "../../../gateway/server-plugin-in-process-dispatch.test-support.js";
import { createSyntheticPluginRuntimeClient } from "../../../gateway/server-plugin-runtime-client.js";
import { createMockGatewayRecoveryRuntime } from "../../../gateway/server-recovery-runtime.test-support.js";
import { rotateAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
import {
  claimAgentRunDelegatedAuthority,
  clearAgentRunContext,
  registerAgentRunContext,
  releaseAgentRunDelegatedAuthority,
  validateAgentRunDelegatedAuthority,
} from "../../../infra/agent-run-registry.js";
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
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { createAdmittedRunOperatorAuthority } from "../../admitted-run-context.js";
import { createTestAdmittedRunContext } from "../../admitted-run-context.test-support.js";
import {
  createCronCreatorAuthorityCapability,
  runWithCronCreatorAuthorityCapability,
} from "../../cron-creator-authority-context.js";
import { withGatewayToolCallerIdentity } from "../../tools/gateway-caller-context.js";
import * as delivery from "../announce/subagent-announce-delivery.js";
import { maybeWakeRequesterAfterAllChildrenSettled } from "../announce/subagent-announce.requester-settle-wake.js";
import { revokeRequesterCronAuthority } from "../requester-cron-authority.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { settleRequesterTurnAfterSessionSpawns } from "./subagent-registry-requester-yield.js";
import {
  createRequesterInitialTransferFixture,
  markRequesterTurnYieldedWithAuthority,
} from "./subagent-registry-requester-yield.test-support.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry-state.fixture.test-support.js";
import {
  activateSubagentRegistry,
  initSubagentRegistry,
  prepareRequesterSettleWakeRecoverySource,
  registerSubagentRun,
  replaceSubagentRunAfterSteerCore,
} from "./subagent-registry.js";
import { settleSubagentRegistryPersistenceWork } from "./subagent-registry.persistence.test-support.js";
import { preparePrivateReplay } from "./subagent-registry.private-input-replay.test-support.js";
import { resetSubagentRegistryForTests, testing } from "./subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { buildRequesterSettleWakeIdentity } from "./subagent-requester-settle-identity.js";

export function registerRequesterCompletionCustodyTests({
  registration,
  updateRun,
}: {
  registration: (
    runId: string,
    overrides?: Partial<Parameters<typeof registerSubagentRun>[0]>,
  ) => Parameters<typeof registerSubagentRun>[0];
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
        const context = createContext();
        context.getRuntimeConfig = () => cfg;
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
        const deliver = vi.spyOn(delivery, "deliverSubagentAnnouncement");
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
          const replacement = createContext();
          replacement.getRuntimeConfig = () => cfg;
          replacement.resolveGatewayContext = () => replacement;
          replacement.recoveryRuntime = createMockGatewayRecoveryRuntime();
          const recoveryTarget = {
            ...buildRequesterSettleWakeIdentity({
              requesterSessionKey,
              requesterAgentId: "main",
              batchRunIds: runIds,
              rearmGeneration: 1,
              sharedAttemptKey: true,
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
            getGatewayContextLifetime(replacement.resolveGatewayContext).abort();
            await resetSubagentRegistryForTests({ persist: false });
            rotateAgentEventLifecycleGeneration();
            await initSubagentRegistry();
            const nextGateway = createContext();
            nextGateway.getRuntimeConfig = () => cfg;
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
          await settleSubagentRegistryPersistenceWork();
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
          for (const runId of runIds) {
            await updateRun(runId, (draft) => {
              if (draft.requesterSettleWake) {
                draft.requesterSettleWake.nextAttemptAt = undefined;
              }
            });
          }
          let deliveredAuthority: ReturnType<typeof createAdmittedRunOperatorAuthority> | undefined;
          deliver.mockImplementation(async () => {
            deliveredAuthority =
              getPluginRuntimeGatewayRequestScope()?.client?.internal?.operatorRunAuthority;
            return { delivered: true, path: "direct" };
          });
          const completeBatch = vi.fn();
          const delivered = await maybeWakeRequesterAfterAllChildrenSettled({
            requesterSessionKey,
            settledEntry: currentChild(),
            isSourceCurrent: () => true,
            transitionBatch: async (batch, wake, onPublished) => {
              for (const entry of batch) {
                await updateRun(entry.runId, (draft) => {
                  draft.requesterSettleWake = wake;
                });
              }
              onPublished(batch.map((entry) => subagentRuns.get(entry.runId)!));
            },
            completeBatch,
          });
          expect(
            delivered,
            subagentRuns.get(runIds[0])?.requesterSettleWake?.lastError ?? "requester dispatch",
          ).toBe(canDispatch);
          expect(deliver).toHaveBeenCalledTimes(canDispatch ? 1 : 0);
          if (canDispatch) {
            expect(completeBatch).toHaveBeenCalledOnce();
            expect(deliveredAuthority?.profileId).toBe(source.authority.profileId);
            expect(deliveredAuthority?.scopes).toEqual(["operator.write"]);
            expect(deliveredAuthority?.gatewayAccessGrant).toEqual(grantRef);
            expect(deliveredAuthority?.assertCurrent).not.toThrow();
            const message = deliver.mock.calls[0]?.[0].triggerMessage;
            expect(message).toContain("restart-child-a interrupted by Gateway restart");
            expect(message).toContain("restart-child-b interrupted by Gateway restart");
          }
          for (const runId of runIds) {
            expect(loadSubagentRegistryFromSqlite().get(runId)?.completion?.resultText).toBe(
              `${runId} interrupted by Gateway restart`,
            );
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

  it.each(["current", "revoked"] as const)(
    "keeps %s original completion custody after a same-human chat admission revokes automation",
    async (authority) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const cfg = { session: { store: state.path("sessions.json") } };
        vi.mocked(config.getRuntimeConfig).mockReturnValue(cfg);
        const requesterSessionKey = "agent:main:main";
        const sessionId = "yielded-requester";
        const requesterTurnRunId = "original-requester";
        const runId = "yielded-child";
        await upsertSessionEntryCore(
          { storePath: cfg.session.store, sessionKey: requesterSessionKey, agentId: "main" },
          { sessionId, updatedAt: 1 },
        );
        const context = createContext();
        context.getRuntimeConfig = () => cfg;
        context.resolveGatewayContext = () => context;
        const client = createOperatorClient({
          profileName: "original-requester",
          scopes: ["operator.admin"],
        });
        const revoked = new AbortController();
        const source = expectDefined(
          await operatorCapture.captureGatewayOperatorRunAuthority({
            client,
            context,
            sourceAuthority: {
              signal: revoked.signal,
              assertCurrent: () => revoked.signal.throwIfAborted(),
            },
          }),
          "original requester source",
        );
        client.internal = { operatorRunAuthority: source.authority };
        const { operationalRunInstance } = createTestAdmittedRunContext(requesterTurnRunId);
        const delegated = claimAgentRunDelegatedAuthority(operationalRunInstance);
        registerAgentRunContext(requesterTurnRunId, {
          agentId: "main",
          sessionKey: requesterSessionKey,
          sessionId,
        });
        const capability = expectDefined(
          createCronCreatorAuthorityCapability(
            requesterTurnRunId,
            { kind: "unknown" },
            { source: "control-ui-admin" },
          ),
          "original automation management capability",
        );
        const transfer = createRequesterInitialTransferFixture(subagentRuns);
        const requester = { requesterSessionKey, requesterAgentId: "main", requesterTurnRunId };
        const deliver = vi.spyOn(delivery, "deliverSubagentAnnouncement");
        try {
          await withPluginRuntimeGatewayRequestScope(
            {
              client,
              context,
              resolveGatewayContext: () => context,
              isWebchatConnect: () => false,
            },
            () =>
              runWithCronCreatorAuthorityCapability(capability, () =>
                withGatewayToolCallerIdentity(
                  {
                    agentId: "main",
                    sessionKey: requesterSessionKey,
                    operationalRunInstance,
                    approvalAuthority: delegated,
                    operatorAuthority: source.authority,
                    receiptAuthority: () => validateAgentRunDelegatedAuthority(delegated),
                  },
                  async () => {
                    await registerSubagentRun(
                      registration(runId, { ...requester, gatewayContextResolver: () => context }),
                    );
                    expect(
                      await markRequesterTurnYieldedWithAuthority({
                        ...requester,
                        runs: subagentRuns,
                        transfer,
                      }),
                    ).toBe(1);
                    expect(
                      await settleRequesterTurnAfterSessionSpawns({
                        ...requester,
                        requesterYielded: true,
                        acceptedSessionSpawns: [
                          {
                            runId,
                            childSessionKey: subagentRuns.get(runId)!.childSessionKey,
                            expectsCompletionMessage: true,
                          },
                        ],
                        runs: subagentRuns,
                        transfer,
                        schedule: () => {},
                      }),
                    ).toBe(true);
                  },
                ),
              ),
          );
          releaseAgentRunDelegatedAuthority(delegated);
          clearAgentRunContext(requesterTurnRunId);
          source.release();
          expect(capability.active).toBe(false);
          expect(source.authority.assertCurrent).not.toThrow();

          // A fresh connection for the same human may manage automations; the old batch may not.
          const freshClient = createOperatorClient({
            profileId: source.authority.profileId,
            scopes: ["operator.admin", "operator.approvals"],
          });
          freshClient.internal = { controlUiAdmin: true };
          expect(
            resolveGatewayChatCronCreatorAuthorityAdmission({
              runId: "same-human-next-message",
              resolvedSessionKey: requesterSessionKey,
              client: freshClient,
              hasExplicitOrigin: false,
              hasRestoredCronContinuation: false,
              isIncognito: false,
              isReconnectResume: false,
              isSystemGenerated: false,
              turnKind: "main",
              isDirectExternalUser: true,
            }),
          ).toMatchObject({ managementEntitlement: { source: "control-ui-admin" } });
          await updateRun(runId, (draft) => {
            draft.execution = {
              status: "terminal",
              endedAt: Date.now(),
              outcome: { status: "ok" },
            };
            draft.completion = {
              required: true,
              resultText: "Original child result",
              terminalReply: { disposition: "visible", text: "Original child result" },
            };
            draft.delivery = { status: "delivered" };
          });
          if (authority === "revoked") {
            revoked.abort(new Error("original operator source revoked"));
          }
          deliver.mockImplementation(async (params) => {
            const retained =
              getPluginRuntimeGatewayRequestScope()?.client?.internal?.operatorRunAuthority;
            expect(retained?.source).toBe(source.authority.source);
            expect(retained?.scopes).toEqual(["operator.admin"]);
            expect(params.triggerMessage).toContain("Original child result");
            expect(
              resolveGatewayCronCreatorAuthorityAdmission({
                runId: params.directIdempotencyKey!,
                resolvedSessionKey: requesterSessionKey,
                sessionId,
                client: createSyntheticPluginRuntimeClient(),
                request: {
                  message: params.triggerMessage,
                  idempotencyKey: params.directIdempotencyKey!,
                },
                inputProvenance: {
                  kind: "inter_session",
                  sourceSessionKey: subagentRuns.get(runId)!.childSessionKey,
                  sourceTool: "subagent_settle",
                },
                hasRestoredCronContinuation: false,
                isOneShotModelRun: false,
                isRestartRecoveryResumeRun: false,
              }),
            ).toBeUndefined();
            return { delivered: true, path: "direct" };
          });
          const completeBatch = vi.fn();
          const unrelatedClient = createOperatorClient({
            profileName: "unrelated-ambient-operator",
            scopes: ["operator.admin", "operator.pairing"],
          });
          // Exercise the real settle dispatcher, including its canonical registry authority wrapper.
          const delivered = await withPluginRuntimeGatewayRequestScope(
            { client: unrelatedClient, context, isWebchatConnect: () => false },
            () =>
              maybeWakeRequesterAfterAllChildrenSettled({
                requesterSessionKey,
                settledEntry: subagentRuns.get(runId)!,
                isSourceCurrent: () => true,
                transitionBatch: async (_batch, wake, onPublished) => {
                  await updateRun(runId, (draft) => {
                    draft.requesterSettleWake = wake;
                  });
                  onPublished([subagentRuns.get(runId)!]);
                },
                completeBatch,
              }),
          );
          expect(delivered).toBe(authority === "current");
          if (authority === "current") {
            expect(deliver).toHaveBeenCalledOnce();
            expect(completeBatch).toHaveBeenCalledWith(
              expect.any(Array),
              expect.any(Number),
              { delivered: true, path: "direct" },
              expect.any(Function),
            );
          } else {
            expect(deliver).not.toHaveBeenCalled();
            expect(subagentRuns.get(runId)?.requesterSettleWake?.lastError).toBe(
              "Subagent completion authority is no longer active",
            );
          }
        } finally {
          deliver.mockRestore();
          releaseAgentRunDelegatedAuthority(delegated);
          clearAgentRunContext(requesterTurnRunId);
          revokeRequesterCronAuthority(requesterSessionKey);
          source.release();
          await resetSubagentRegistryForTests({ persist: false });
        }
      });
    },
  );
}
