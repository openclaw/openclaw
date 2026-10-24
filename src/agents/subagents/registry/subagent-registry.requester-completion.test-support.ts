import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import * as config from "../../../config/config.js";
import { upsertSessionEntryCore } from "../../../config/sessions/session-accessor.js";
import { captureAgentTurnPrincipal } from "../../../gateway/agent-turn/principal.js";
import * as operatorCapture from "../../../gateway/operator-run-authority.js";
import * as operatorRecovery from "../../../gateway/operator-run-recovery.js";
import { createContext } from "../../../gateway/server-plugin-in-process-dispatch.test-support.js";
import { createMockGatewayRecoveryRuntime } from "../../../gateway/server-recovery-runtime.test-support.js";
import {
  enforceSharedGatewaySessionGenerationForConfigWrite,
  SharedGatewaySessionGenerationState,
} from "../../../gateway/server-shared-auth-generation.js";
import { resolveSharedGatewaySessionGeneration } from "../../../gateway/server/ws-shared-generation.js";
import { rotateAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
import {
  clearAgentRunContext,
  registerAgentRunContext,
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
import { createDeferredCore } from "../../../shared/deferred.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { createAdmittedRunOperatorAuthority } from "../../admitted-run-context.js";
import { createRestartRecoveryRequesterSource } from "../../requester-run-recovery-source.js";
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
import {
  createRequesterCompletionClient,
  prepareNestedRequesterReplay,
  requesterCompletionRecoveryCases,
  type RegistryRegistrationFixture,
} from "./subagent-registry.requester-completion.fixture.test-support.js";
import { resetSubagentRegistryForTests, testing } from "./subagent-registry.test-helpers.js";
import { buildRequesterSettleWakeIdentity } from "./subagent-requester-settle-identity.js";

export function registerRequesterCompletionCustodyTests({
  registration,
  updateRun,
}: RegistryRegistrationFixture) {
  it.each(requesterCompletionRecoveryCases)(
    "revalidates %s for a cold-loaded interrupted child batch without widening the parent",
    async (recovery) => {
      const owner = recovery.startsWith("owner ");
      const spawnsChild = recovery.endsWith(" with child");
      const revokesChild = recovery === "owner revoked with child";
      const nestedReplay =
        recovery === "owner nested committed replay" || recovery === "owner nested adopted replay";
      const nestedOwner = recovery.startsWith("owner nested ");
      const ownerAuth = nestedOwner
        ? { mode: "password" as const, password: "owner-password-fixture" }
        : { mode: "token" as const, token: "owner-token-fixture" };
      const ownerGeneration = resolveSharedGatewaySessionGeneration({
        ...ownerAuth,
        allowTailscale: false,
      });
      const overloaded = recovery.startsWith("overloaded");
      const unavailablePolicy = recovery === "unavailable policy then current";
      const missingSource = recovery.startsWith("missing source");
      const terminalRecovery =
        missingSource ||
        recovery === "missing parent source" ||
        recovery === "mismatched source" ||
        recovery === "revoked grant";
      const canDispatch =
        spawnsChild ||
        recovery === "current" ||
        recovery === "owner current" ||
        nestedOwner ||
        recovery === "overloaded then current" ||
        unavailablePolicy;
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const cfg = {
          session: { store: state.path("sessions.json") },
          ...(owner ? { gateway: { auth: ownerAuth } } : {}),
        };
        config.setRuntimeConfigSnapshot(cfg);
        vi.mocked(config.getRuntimeConfig).mockReturnValue(cfg);
        const requesterSessionKey = nestedOwner
          ? "agent:main:subagent:restart-lead"
          : "agent:main:main";
        const sessionId = "restart-requester";
        const lifecycleRevision = "restart-requester-lifecycle";
        const requesterTurnRunId = "restart-parent-turn";
        const runIds: [string, string] = ["restart-child-a", "restart-child-b"];
        const nested = nestedReplay
          ? await prepareNestedRequesterReplay({
              cfg,
              requesterSessionKey,
              sessionId,
              lifecycleRevision,
              runIds,
              adoptAfterRestart: recovery === "owner nested adopted replay",
            })
          : undefined;
        const currentChild = (runId = runIds[0]) =>
          expectDefined(subagentRuns.get(runId), "restored child");
        await upsertSessionEntryCore(
          { storePath: cfg.session.store, sessionKey: requesterSessionKey, agentId: "main" },
          {
            sessionId,
            lifecycleRevision,
            updatedAt: 1,
            ...(nestedOwner ? { spawnDepth: 1 } : {}),
            ...(nested ? { lifecycleRunId: nested.runId } : {}),
            ...(recovery === "missing source with unrelated requester claim"
              ? {
                  abortedLastRun: true,
                  restartRecoveryDeliveryRunId: "unrelated-recovery",
                  restartRecoveryDeliverySourceRunId: "unrelated-requester-turn",
                  restartRecoveryRequesterSource: expectDefined(
                    createRestartRecoveryRequesterSource({
                      agentId: "main",
                      sessionKey: requesterSessionKey,
                      entry: { sessionId, lifecycleRevision, updatedAt: 1 },
                      sourceRunId: "unrelated-requester-turn",
                      requesterOrigin: {
                        sessionKey: requesterSessionKey,
                        messageProvider: "telegram",
                        senderId: "another-channel-requester",
                      },
                    }),
                    "authenticated channel requester source",
                  ),
                }
              : {}),
          },
        );
        const context = createContext([], () => cfg);
        context.resolveGatewayContext = () => context;
        const client = createRequesterCompletionClient({
          cfg,
          context,
          owner,
          ownerAuthMethod: ownerAuth.mode,
          ownerGeneration,
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
        if (!owner) {
          registry.gatewayAccessPolicies.push({
            pluginId: grantRef.pluginId,
            source: "fixture",
            policy: {
              authorize: () => (grantCurrent ? grant : undefined),
              resume: resumeGrant,
            },
          });
        }
        const previousRegistry = captureActivePluginRegistrySnapshot();
        stageActivePluginRegistry(registry, null, "default");
        const source = expectDefined(
          await operatorCapture.captureGatewayOperatorRunAuthority({
            client: expectDefined(captureAgentTurnPrincipal(client), "authenticated requester"),
            context,
            sourceAuthority: owner
              ? null
              : { gatewayAccessGrant: grantRef, assertCurrent: grant.assertCurrent },
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
        let childAuthority: typeof deliveredAuthority;
        const childRunId = "replacement-child";
        const deliverActual = delivery.deliverSubagentAnnouncement;
        const deliveredParams: Parameters<typeof deliverActual>[0][] = [];
        const deliver = vi
          .spyOn(delivery, "deliverSubagentAnnouncement")
          .mockImplementation(async (params) => {
            if (nested && params.expectsCompletionMessage) {
              const deferredDelivery = await deliverActual(params);
              expect(deferredDelivery).toMatchObject({
                delivered: false,
                reason: "completion_handoff_pending",
                disposition: "intentional_non_delivery",
              });
              return deferredDelivery;
            }
            await params.onBeforeDispatch?.();
            deliveredAuthority =
              getPluginRuntimeGatewayRequestScope()?.client?.internal?.operatorRunAuthority;
            expectDefined(deliveredAuthority, "restored requester authority").assertCurrent();
            if (nested && params.targetRequesterSessionKey === requesterSessionKey) {
              await nested.complete(params);
            }
            if (nested && !nested.admitRequester(params)) {
              return { delivered: false, path: "none", disposition: "session_queued" };
            }
            if (spawnsChild && !childAuthority) {
              const gateway = expectDefined(
                getPluginRuntimeGatewayRequestScope()?.context,
                "recovered requester Gateway",
              );
              await upsertSessionEntryCore(
                {
                  storePath: cfg.session.store,
                  sessionKey: `agent:main:subagent:${childRunId}`,
                  agentId: "main",
                },
                { sessionId: `original-${childRunId}`, updatedAt: Date.now() },
              );
              registerAgentRunContext(childRunId, {
                agentId: "main",
                sessionKey: `agent:main:subagent:${childRunId}`,
                sessionId: `original-${childRunId}`,
              });
              await registerSubagentRun(
                registration(childRunId, {
                  requesterSessionKey,
                  requesterAgentId: "main",
                  requesterTurnRunId: "recovered-requester-turn",
                  completionTarget: "parent",
                  completionRequesterSessionId: sessionId,
                  completionRequesterLifecycleRevision: lifecycleRevision,
                  gatewayContextResolver: () => gateway,
                }),
              );
              childAuthority = subagentRuns.runWithCompletionAuthority(
                currentChild(childRunId),
                () => getPluginRuntimeGatewayRequestScope()?.client?.internal?.operatorRunAuthority,
              );
              expectDefined(childAuthority, "replacement child authority").assertCurrent();
            }
            params.onAccepted?.({ status: "accepted" });
            deliveredParams.push(params);
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
              await nested?.register(registration, updateRun, context);
              for (const runId of runIds) {
                await registerSubagentRun(
                  registration(runId, {
                    requesterSessionKey,
                    requesterAgentId: "main",
                    requesterTurnRunId,
                    completionTarget:
                      recovery === "missing source with unrelated requester claim"
                        ? undefined
                        : "parent",
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
              snapshot: { scopes: ["operator.write"], grant: owner ? null : grantRef },
            });
            if (owner) {
              expect(admitted?.operatorRecoverySource?.snapshot).toMatchObject({
                sharedGeneration: ownerGeneration,
                authPolicy: { authMethod: ownerAuth.mode },
              });
              expect(JSON.stringify(admitted?.operatorRecoverySource)).not.toContain(
                nestedOwner ? ownerAuth.password : ownerAuth.token,
              );
            }
            // Crash after interruption was recorded, before its parent continuation was dispatched.
            await updateRun(runId, (draft) => {
              const text = `${runId} interrupted by Gateway restart`;
              draft.execution = {
                ...draft.execution,
                status: "terminal",
                endedAt: Date.now(),
                interruptionReason: "gateway-restart",
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
                status:
                  terminalRecovery || unavailablePolicy || nestedReplay ? "dispatching" : "pending",
                attemptCount: terminalRecovery || unavailablePolicy || nestedReplay ? 1 : 0,
                rearmGeneration: 1,
                batchRunIds: runIds,
                nextAttemptAt: Date.now() + 60_000,
              };
              if (missingSource) {
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
          const replay = await preparePrivateReplay(
            recovery === "current" || nestedReplay ? stale : undefined,
            nested?.runId,
          );
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
          if (owner) {
            replacement.sharedGatewaySessionGenerationState =
              new SharedGatewaySessionGenerationState({
                current:
                  recovery === "owner rotated"
                    ? resolveSharedGatewaySessionGeneration({
                        mode: "token",
                        token: "rotated-owner-fixture",
                        allowTailscale: false,
                      })
                    : ownerGeneration,
                required: null,
              });
          }
          replacement.recoveryRuntime = createMockGatewayRecoveryRuntime({
            waitForAgent: vi.fn().mockResolvedValue({ status: "pending" }),
          });
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
          await activateSubagentRegistry(() => replacement).settled;
          await replay?.();
          if (terminalRecovery) {
            if (missingSource) {
              // Registry binding already settled the unavailable continuation.
              await expect(prepareRecovery()).resolves.toBeUndefined();
            } else {
              await expect(prepareRecovery()).resolves.toEqual({
                status: "unrestorable",
                reason: expect.stringMatching(
                  recovery === "revoked grant"
                    ? /Gateway access is not active/
                    : /original operator/,
                ),
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
            await activateSubagentRegistry(() => nextGateway).settled;
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
          if (overloaded || unavailablePolicy) {
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
          if (overloaded || unavailablePolicy || recovery === "revoked after restore") {
            const resumedGrants = resumeGrant.mock.calls.length;
            await testing.sweepOnceForTests();
            expect(resumeGrant).toHaveBeenCalledTimes(resumedGrants);
          }
          if (recovery !== "replaced requester" && !owner) {
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
          nested?.expectCompleted(settled, deliveredParams);
          expect(deliveredParams).toHaveLength(nestedReplay ? 2 : canDispatch ? 1 : 0);
          if (canDispatch) {
            expect(deliver).toHaveResolvedTimes(deliver.mock.calls.length);
            expect(deliveredAuthority?.profileId).toBe(source.authority.profileId);
            expect(deliveredAuthority?.scopes).toEqual(["operator.write"]);
            expect(deliveredAuthority?.gatewayAccessGrant).toEqual(owner ? null : grantRef);
            if (!spawnsChild) {
              // Committed batch settlement releases its restored completion custody.
              expect(deliveredAuthority?.assertCurrent).toThrow(/authority/);
            }
            const message = deliver.mock.calls[0]?.[0].triggerMessage;
            expect(message).toContain("restart-child-a interrupted by Gateway restart");
            expect(message).toContain("restart-child-b interrupted by Gateway restart");
          }
          if (spawnsChild) {
            const child = currentChild(childRunId);
            const retained = expectDefined(childAuthority, "retained replacement child authority");
            expect(retained.assertCurrent).not.toThrow();
            expect(retained.signal?.aborted).toBe(false);
            expect(child.execution).toMatchObject({ status: "running" });
            expect(retained.scopes).toEqual(["operator.write"]);
            expect(() => subagentRuns.runWithCompletionAuthority(child, () => {})).not.toThrow();
            expect(() => subagentRuns.runWithCompletionAuthority(currentChild(), () => {})).toThrow(
              /authority/,
            );
            if (revokesChild) {
              const generation = resolveSharedGatewaySessionGeneration({
                mode: "token",
                token: "rotated-owner-fixture",
                allowTailscale: false,
              });
              const generationOwner = expectDefined(
                replacement.sharedGatewaySessionGenerationState,
                "shared authentication owner",
              );
              enforceSharedGatewaySessionGenerationForConfigWrite({
                state: generationOwner,
                nextConfig: cfg,
                resolveRuntimeSnapshotGeneration: () => generation,
                clients: [],
              });
              expect(retained.signal?.aborted).toBe(true);
              expect(retained.assertCurrent).toThrow(/authority/);
            }
            await updateRun(childRunId, (draft) => {
              draft.execution = {
                ...draft.execution,
                status: "terminal",
                endedAt: Date.now(),
                outcome: { status: "ok" },
              };
              draft.completion = {
                required: true,
                resultText: "replacement child completed",
                terminalReply: { disposition: "visible", text: "replacement child completed" },
              };
              draft.delivery = { status: "pending" };
              draft.cleanupCompletedAt = Date.now();
              draft.requesterTurnRunId = undefined;
              draft.requesterSettleWake = {
                status: "pending",
                attemptCount: 0,
                rearmGeneration: 1,
                batchRunIds: [childRunId],
              };
            });
            clearAgentRunContext(childRunId);
            await testing.sweepOnceForTests();
            await join(true);
            await settleSubagentRegistryPersistenceWork();
            expect(deliver).toHaveBeenCalledTimes(revokesChild ? 1 : 2);
            if (!revokesChild) {
              expect(deliver.mock.calls[1]?.[0].triggerMessage).toContain(
                "replacement child completed",
              );
            }
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
          clearAgentRunContext(childRunId);
          resumeDelivery.resolve();
          await join();
          requesterRead.mockRestore();
          if (overloaded) {
            vi.mocked(operatorRecovery.restoreGatewayOperatorSource).mockRestore();
          }
          deliver.mockRestore();
          nested?.dispose();
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
