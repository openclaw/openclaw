import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { clearSessionGoal } from "../../config/sessions/goals.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import {
  loadSessionEntry,
  replaceSessionEntry,
  appendTranscriptMessage,
} from "../../config/sessions/session-accessor.js";
import { projectPublicSessionEntry } from "../../config/sessions/session-entry-projection.js";
import { SESSION_TOTAL_TOKENS_VERSION } from "../../config/sessions/types.js";
import { closeGatewayDeviceRevocation } from "../../gateway/device-revocation.js";
import { createGatewayInstanceRuntime } from "../../gateway/server-instance-runtime.js";
import { createGatewayRequestContext } from "../../gateway/server-request-context.js";
import { makeContextParams } from "../../gateway/server-request-context.test-support.js";
import { SharedGatewaySessionGenerationState } from "../../gateway/server-shared-auth-generation.js";
import { persistGatewaySessionLifecycleEvent } from "../../gateway/session-lifecycle-state.js";
import { prepareRepositoryWorkerProjectSource } from "../../gateway/worker-environments/repository-project-admission.js";
import {
  getAgentEventLifecycleGeneration,
  rotateAgentEventLifecycleGeneration,
} from "../../infra/agent-events.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
} from "../../plugins/runtime.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db-cache.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import { setCanonicalUserProfileRole } from "../../state/user-profile-writes.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  readAdmittedRunOperatorAuthority,
  assertOperatorModelAllowed,
} from "../admitted-run-context.js";
import * as attemptRuntime from "../command/attempt-execution.runtime.js";
import { refreshPreparedModelRuntimeSnapshots } from "../prepared-model-runtime.js";
import { createAgentRunRestartAbortError } from "../run-termination.js";
import { withGatewayToolCallerIdentity } from "../tools/gateway-caller-context.js";
import { createCreateGoalTool } from "../tools/goal-tools.js";
import {
  factoryRestartChanges,
  installFactoryRestartRepositoryFixture,
} from "./main-session-recovery-factory-read.test-support.js";
import { applyOriginalIssuerStartupChange } from "./main-session-recovery-issuer-changes.test-support.js";
import {
  createOriginalIssuerFixture,
  legacyIssuerChanges,
  acceptedTurnChanges,
  acceptOriginalIssuerTurn,
  interruptOriginalNoGoalTurn,
  assertInterruptedOriginalInput,
  pauseNewGoalDuringOriginalDrain,
  assertRecoveredOriginalInput,
  readIssuerFixtureHistory,
} from "./main-session-recovery-original-issuer.test-support.js";
import {
  retiredOriginalSourceChanges,
  retireOriginalAcceptedSourceFence,
  assertOriginalSourceRecoveryEffects,
  commitOriginalAcceptedInput,
} from "./main-session-recovery-retired-source.test-support.js";
import {
  markRestartAbortedMainSessions,
  markStartupOrphanedMainSessionsForRecovery,
} from "./main-session-restart-recovery-marking.js";
import {
  scheduleRestartAbortedMainSessionRecovery,
  recoverRestartAbortedMainSessions,
  retryRestartAbortedMainSessionRecovery,
} from "./main-session-restart-recovery-runtime.js";
import { mainSessionRecoveryLog } from "./main-session-restart-recovery-shared.js";
import * as recoveryStore from "./main-session-restart-recovery-store.js";

export async function exerciseTrustedGoalStartup(
  factoryRepository = false,
  noGoal = false,
  activeGoalAccepted = false,
  retiredSource: boolean | "conflicting" = false,
) {
  const acceptedTurn = noGoal || activeGoalAccepted;
  await withOpenClawTestState({ label: "original-goal-issuer" }, async (state) => {
    if (!noGoal) {
      vi.stubEnv("FACTORY_AUTH_MODE", "github");
    }
    const registrySnapshot = captureActivePluginRegistrySnapshot();
    const changes =
      retiredSource === "conflicting"
        ? (["current grant"] as const)
        : retiredSource
          ? retiredOriginalSourceChanges
          : activeGoalAccepted
            ? (["current grant", "accepted issuer mismatch"] as const)
            : noGoal
              ? acceptedTurnChanges
              : factoryRepository
                ? factoryRestartChanges
                : legacyIssuerChanges;
    let originalTurnRunId = "";
    let commitOriginalInput = async () => {};
    let originalReached = createDeferred();
    let originalStopped = createDeferred();
    let effectCount = 0;
    let expectedRepositoryUrl = "";
    let nextBrokerContext: ReturnType<typeof createGatewayRequestContext>;
    let repositoryFixture: ReturnType<typeof installFactoryRestartRepositoryFixture> | undefined;
    if (factoryRepository) {
      vi.stubEnv("GH_CONFIG_DIR", state.statePath("gh"));
      repositoryFixture = installFactoryRestartRepositoryFixture({
        binding: () => ({
          actorId: expectedActorId,
          profileId: expectedProfileId,
          ...currentTarget,
          sessionId: expectedSessionId,
          repositoryUrl: expectedRepositoryUrl,
          context: nextBrokerContext,
        }),
        broker: () =>
          currentChange === "broker lease missing"
            ? "missing lease"
            : currentChange === "broker actor changed"
              ? "different actor"
              : "current",
        afterLookup: async () => {
          if (currentChange === "late role revoke") {
            await setCanonicalUserProfileRole(expectedProfileId, "revoked");
          } else if (currentChange === "late repository replaced") {
            const entry = loadSessionEntry(currentTarget)!;
            await replaceSessionEntry(currentTarget, {
              ...entry,
              repositoryWorkspaceId: "replacement-workspace",
            });
          }
        },
      });
    }
    const execution = vi
      .spyOn(attemptRuntime, "runAgentAttempt")
      .mockImplementation(async (params) => {
        if (acceptedTurn && params.runId === originalTurnRunId) {
          commitOriginalInput = () =>
            commitOriginalAcceptedInput(params.opts.userTurnTranscriptRecorder);
          originalReached.resolve();
          await originalStopped.promise;
          throw createAgentRunRestartAbortError();
        }
        const admitted = await params.preparedRunAdmission.admit("embedded");
        const authority = readAdmittedRunOperatorAuthority(admitted);
        expect(authority?.profileId).toBe(expectedProfileId);
        expect(authority?.scopes).toEqual(["operator.read", "operator.write"]);
        expect(authority?.scopes).not.toContain("operator.admin");
        if (currentChange === "late role revoke" && !factoryRepository) {
          await setCanonicalUserProfileRole(expectedProfileId, "revoked");
          expect(() => authority!.assertCurrent()).toThrow();
          throw new Error("Synthetic issuer revoked before effect");
        }
        authority!.assertCurrent();
        assertOperatorModelAllowed(authority, { provider: "fixture", model: "allowed" });
        expect(() =>
          assertOperatorModelAllowed(authority, { provider: "fixture", model: "forbidden" }),
        ).toThrow();
        const fresh = loadSessionEntry(currentTarget)!;
        expect(fresh.sessionId).toBe(expectedSessionId);
        if (noGoal) {
          expect(fresh.goal).toBeUndefined();
          await assertRecoveredOriginalInput(currentTarget, expectedSessionId, originalTurnRunId);
        } else {
          expect(fresh.goal, JSON.stringify(fresh.goal)).toMatchObject({
            id: expectedGoalId,
            status: "active",
            tokensUsed: 120,
            tokenBudget: 500,
            tokenStart: 100,
            continuationTurns: 0,
          });
        }
        if (activeGoalAccepted) {
          await assertRecoveredOriginalInput(currentTarget, expectedSessionId, originalTurnRunId);
        }
        if (factoryRepository) {
          const readNativeCredential = authority!.createFactoryGitHubDispatchCredentialReader!({
            ...currentTarget,
            sessionId: expectedSessionId,
            repositoryUrl:
              currentChange === "wrong repository"
                ? "https://microsoft.ghe.com/other/not-accepted.git"
                : expectedRepositoryUrl,
            assertCurrent: () => authority!.assertCurrent(),
          });
          const source = await prepareRepositoryWorkerProjectSource({
            namespace: "restored-factory",
            repository: { agentId: "main", url: expectedRepositoryUrl, ref: "main" },
            getConfig: () => nextBrokerContext.getRuntimeConfig(),
            assertCurrent: () => authority!.assertCurrent(),
            readNativeCredential,
          });
          expect(source.project.source.url).toBe(expectedRepositoryUrl);
          expect(source.project.source.owner.identity).toMatchObject({
            source: "system-detected",
            accountId: expectedActorId,
          });
        }
        effectCount += 1;
        await params.onAgentEvent({ stream: "lifecycle", data: { phase: "start" } });
        await params.opts.onExecutionStarted?.();
        return {
          payloads: [],
          meta: {
            durationMs: 0,
            agentMeta: {
              sessionId: params.sessionId,
              provider: "fixture",
              model: "allowed",
              usage: { input: 0, output: 0, total: 0 },
            },
            stopReason: "stop",
          },
        };
      });
    let expectedProfileId = "";
    let expectedSessionId = "";
    let expectedGoalId = "";
    let expectedActorId = 0;
    let currentChange: (typeof changes)[number] = "current";
    let currentTarget = { agentId: "main", sessionKey: "agent:main:issuer" };
    try {
      for (const [index, change] of changes.entries()) {
        currentChange = change;
        const issuerFixture = await createOriginalIssuerFixture(state, index, change);
        const {
          profile,
          cfg: initialConfig,
          work,
          context,
          runtime,
          methods,
          client,
          deviceSource,
          original,
        } = issuerFixture;
        let cfg = initialConfig;
        expectedProfileId = profile.id;
        expectedActorId = 700100 + index;
        expectedRepositoryUrl = `https://microsoft.ghe.com/acme/issuer-${index}.git`;
        currentTarget = { agentId: "main", sessionKey: `agent:main:issuer-${index}` };
        expectedSessionId = `issuer-session-${index}`;
        await replaceSessionEntry(currentTarget, {
          sessionId: expectedSessionId,
          lifecycleRevision: `issuer-life-${index}`,
          status: "done",
          updatedAt: Date.now(),
          totalTokens: 100,
          totalTokensFresh: true,
          totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
          createdActor: { type: "human", source: "profile", id: profile.id },
        });
        if (noGoal) {
          const workspace = await getSessionRepositoryWorkspaceStore().create({
            ...currentTarget,
            url: expectedRepositoryUrl,
            requestedRef: "main",
            runSetupScript: false,
            assertCurrent: original!.authority.assertCurrent,
          });
          await replaceSessionEntry(currentTarget, {
            ...loadSessionEntry(currentTarget)!,
            repositoryWorkspaceId: workspace.workspaceId,
          });
          originalTurnRunId = `accepted-no-goal-${index}`;
          originalReached = createDeferred();
          originalStopped = createDeferred();
          await acceptOriginalIssuerTurn(
            issuerFixture,
            currentTarget,
            expectedSessionId,
            originalTurnRunId,
            workspace.workspaceId,
            expectedActorId,
          );
          await originalReached.promise;
          if (retiredSource) {
            await commitOriginalInput();
          }
        } else {
          await appendTranscriptMessage(
            { ...currentTarget, sessionId: expectedSessionId },
            {
              cwd: state.workspaceDir,
              message: {
                role: "user",
                content: "Accepted issuer fixture work",
                idempotencyKey: `original-${index}`,
              },
            },
          );
          const tool = createCreateGoalTool({
            agentSessionKey: currentTarget.sessionKey,
            sessionAgentId: "main",
            config: cfg,
          });
          await withGatewayToolCallerIdentity(
            {
              ...currentTarget,
              gatewayContextResolver: () => context,
              ...(change === "forged only" ? {} : { operatorAuthority: original!.authority }),
            },
            () =>
              tool.execute!("create-fixture-goal", {
                objective: "Finish the accepted fixture",
                token_budget: 500,
                issuer: { profileId: "forged-owner", scopes: ["operator.admin"] },
              }),
          );
        }
        let entry = loadSessionEntry(currentTarget)!;
        expectedGoalId = entry.goal?.id ?? "";
        if (!noGoal) {
          if (change === "forged only") {
            expect(entry.mainRestartRecovery?.goalIntent).toBeUndefined();
          } else {
            expect(entry.mainRestartRecovery?.goalIntent?.issuer.profileId).toBe(profile.id);
            expect(entry.mainRestartRecovery?.goalIntent?.issuer.device.identity).toBe(
              expectDefined(client.internal, "original authenticated metadata")
                .operatorPairingIdentity,
            );
            if (factoryRepository) {
              expect(entry.mainRestartRecovery?.goalIntent?.issuer.factoryActor).toEqual({
                host: "microsoft.ghe.com",
                accountId: expectedActorId,
              });
              expect(projectPublicSessionEntry(entry)).not.toHaveProperty("mainRestartRecovery");
            }
          }
        }
        if (factoryRepository && !noGoal) {
          const repository = await getSessionRepositoryWorkspaceStore().create({
            ...currentTarget,
            url: expectedRepositoryUrl,
            requestedRef: "main",
            runSetupScript: false,
            assertCurrent: () => {},
          });
          entry = { ...entry, repositoryWorkspaceId: repository.workspaceId };
        }
        await replaceSessionEntry(currentTarget, {
          ...entry,
          totalTokens: change === "budget exhausted" ? 600 : 220,
          ...(noGoal
            ? {}
            : { goal: { ...entry.goal!, tokensUsed: change === "budget exhausted" ? 500 : 120 } }),
        });
        if (activeGoalAccepted) {
          originalTurnRunId = `accepted-active-goal-${index}`;
          originalReached = createDeferred();
          originalStopped = createDeferred();
          await acceptOriginalIssuerTurn(
            issuerFixture,
            currentTarget,
            expectedSessionId,
            originalTurnRunId,
            entry.repositoryWorkspaceId!,
            expectedActorId,
            expectedGoalId,
          );
          await originalReached.promise;
        }
        await markRestartAbortedMainSessions({
          cfg,
          stateDir: state.stateDir,
          activeRuns: acceptedTurn
            ? [
                {
                  ...currentTarget,
                  sessionId: expectedSessionId,
                  runId: originalTurnRunId,
                  lifecycleGeneration: getAgentEventLifecycleGeneration(),
                  accepted: true,
                },
              ]
            : [],
          resolveGatewayContext: () => context,
          captureGoals: true,
        });
        if (acceptedTurn) {
          interruptOriginalNoGoalTurn(issuerFixture, currentTarget, originalTurnRunId);
          originalStopped.resolve();
          await work.runWhenIdle(() => {});
          if (retiredSource) {
            await retireOriginalAcceptedSourceFence(
              currentTarget,
              originalTurnRunId,
              retiredSource,
            );
          } else {
            await assertInterruptedOriginalInput(currentTarget);
          }
        }
        if (change === "terminal error") {
          const captured = loadSessionEntry(currentTarget)!;
          const capturedGoal = structuredClone(captured.goal);
          const capturedMarker = structuredClone(captured.restartRecoveryGoal);
          await persistGatewaySessionLifecycleEvent({
            ...currentTarget,
            event: {
              sessionId: expectedSessionId,
              runId: "unregistered-late-error",
              ts: Date.now(),
              data: { phase: "error", error: "Synthetic unowned error", endedAt: Date.now() },
            },
          });
          const afterLate = loadSessionEntry(currentTarget)!;
          expect(afterLate.goal).toEqual(capturedGoal);
          expect(afterLate.restartRecoveryGoal).toEqual(capturedMarker);
          expect(afterLate.goalPauseOrigin).toBeUndefined();
          const runId = "original-terminal-error";
          await persistGatewaySessionLifecycleEvent({
            ...currentTarget,
            event: {
              sessionId: expectedSessionId,
              runId,
              lifecycleGeneration: getAgentEventLifecycleGeneration(),
              ts: Date.now(),
              data: { phase: "start", startedAt: Date.now() },
            },
          });
          await persistGatewaySessionLifecycleEvent({
            ...currentTarget,
            event: {
              sessionId: expectedSessionId,
              runId,
              lifecycleGeneration: getAgentEventLifecycleGeneration(),
              ts: Date.now(),
              data: { phase: "error", error: "Synthetic terminal error", endedAt: Date.now() },
            },
          });
          const terminal = loadSessionEntry(currentTarget)!;
          expect(terminal.goalPauseOrigin).toBe("terminal-error");
          expect(terminal.restartRecoveryGoal).toBeUndefined();
          expect(terminal.mainRestartRecovery?.goalIntent?.issuer.profileId).toBe(profile.id);
        }
        entry = loadSessionEntry(currentTarget)!;
        const history = await readIssuerFixtureHistory(currentTarget, expectedSessionId);
        if (noGoal && (change === "cancel" || change === "complete")) {
          await persistGatewaySessionLifecycleEvent({
            ...currentTarget,
            event: {
              runId: originalTurnRunId,
              sessionId: expectedSessionId,
              ts: Date.now(),
              lifecycleGeneration: getAgentEventLifecycleGeneration(),
              data: {
                phase: "end",
                ...(change === "cancel" ? { aborted: true, stopReason: "rpc" } : {}),
              },
            },
          });
        }
        if (noGoal && change === "manual pause") {
          await pauseNewGoalDuringOriginalDrain(issuerFixture, currentTarget);
        }
        original!.release();
        deviceSource.release();
        closeGatewayDeviceRevocation(context);
        runtime.close();
        if (index === 0) {
          await closeOpenClawAgentDatabasesAsync();
          await closeOpenClawStateDatabaseAsync();
        }
        rotateAgentEventLifecycleGeneration();
        cfg = await applyOriginalIssuerStartupChange({
          change,
          fixture: issuerFixture,
          cfg,
          entry,
          currentTarget,
          index,
          expectedActorId,
          noGoal,
        });
        const newShared = new SharedGatewaySessionGenerationState({
          current:
            change === "shared changed"
              ? "changed-shared"
              : change === "verification unavailable"
                ? undefined
                : "original-shared",
          required: null,
        });
        const nextParams = makeContextParams({
          connectionWork: { track: (run) => work.track(run) },
          sharedGatewaySessionGenerationState: newShared,
        });
        const nextContext = createGatewayRequestContext(nextParams);
        nextBrokerContext = nextContext;
        nextContext.getRuntimeConfig = () => cfg;
        nextContext.getCommittedRuntimeConfig = () => cfg;
        nextContext.resolveGatewayContext = () => nextContext;
        nextContext.getGatewayMethodRegistry = () => methods;
        const nextRuntime = createGatewayInstanceRuntime({
          getContext: () => nextContext,
          getMethodRegistry: () => methods,
          isDispatchAvailable: () => true,
        });
        nextContext.recoveryRuntime = nextRuntime.recovery;
        nextContext.createAgentTurnFacade = nextRuntime.createAgentTurnFacade;
        let restorePlanning = () => {};
        const prepareIssuer = nextRuntime.recovery.prepareGoalRecoveryAuthority!;
        const revokeBeforeCommit =
          change === "commit role revoke"
            ? vi
                .spyOn(nextRuntime.recovery, "prepareGoalRecoveryAuthority")
                .mockImplementation(async (...args) => {
                  const restored = await prepareIssuer(...args);
                  const apply = sessionAccessor.applySessionEntryReplacements;
                  const plannedCharge = vi
                    .spyOn(sessionAccessor, "applySessionEntryReplacements")
                    .mockImplementationOnce((params) =>
                      apply({
                        ...params,
                        update: async (entries) => {
                          const planned = await params.update(entries);
                          cfg = {
                            ...cfg,
                            gateway: {
                              ...cfg.gateway,
                              roles: {
                                ...cfg.gateway!.roles!,
                                definitions: {
                                  engineer: {
                                    ...cfg.gateway!.roles!.definitions.engineer!,
                                    scopes: ["operator.read"],
                                  },
                                },
                              },
                            },
                          };
                          setRuntimeConfigSnapshot(cfg, cfg);
                          return planned;
                        },
                      }),
                    );
                  restorePlanning = () => plannedCharge.mockRestore();
                  return restored;
                })
            : undefined;
        setRuntimeConfigSnapshot(cfg, cfg);
        await refreshPreparedModelRuntimeSnapshots(cfg, {
          gatewayLifecycle: true,
          catalogMode: "static",
        });
        const settled = createDeferred();
        const warnings = vi.spyOn(mainSessionRecoveryLog, "warn");
        let counts: Awaited<ReturnType<typeof recoveryStore.recoverStore>> | undefined;
        const recover = recoveryStore.recoverStore;
        const observer = vi
          .spyOn(recoveryStore, "recoverStore")
          .mockImplementation(async (...args) => {
            try {
              counts = await recover(...args);
              return counts;
            } finally {
              settled.resolve();
            }
          });
        const beforeEffects = effectCount;
        const beforeProofs = repositoryFixture?.proofs.size ?? 0;
        const beforeHttp = repositoryFixture?.fetchFixture.mock.calls.length ?? 0;
        const startup = retiredSource
          ? undefined
          : scheduleRestartAbortedMainSessionRecovery({
              getConfig: () => cfg,
              stateDir: state.stateDir,
              delayMs: 0,
              maxRetries: 1,
              gatewayRuntime: nextRuntime.recovery,
            });
        try {
          if (retiredSource) {
            // Foreground recovery must work without a separate startup scan rebuilding fences.
            counts = await retryRestartAbortedMainSessionRecovery({
              ...currentTarget,
              cfg,
              expectedSessionId,
              storePath: resolveSessionStorePathCore(cfg.session?.store, {
                agentId: currentTarget.agentId,
              }),
              gatewayRuntime: nextRuntime.recovery,
            });
          } else {
            await settled.promise;
          }
          await startup?.stop();
          await work.runWhenIdle(() => {});
          const resumed =
            retiredSource !== "conflicting" && (change === "current" || change === "current grant");
          assertOriginalSourceRecoveryEffects({
            change,
            resumed,
            effects: effectCount - beforeEffects,
            counts,
            warnings: warnings.mock.calls.map(([text]) => text),
            source: retiredSource,
            fixture: issuerFixture,
          });
          if (change === "uncaptured issuer" || change === "terminal error") {
            expect(warnings).toHaveBeenCalledWith(
              "Original goal issuer is unavailable without a captured recovery marker",
            );
          }
          const saved = loadSessionEntry(currentTarget)!;
          if (!noGoal) {
            expect(saved.goal?.tokenBudget, change).toBe(change === "cancel" ? undefined : 500);
            expect(saved.goal?.tokensUsed, change).toBe(
              change === "cancel" ? undefined : change === "budget exhausted" ? 500 : 120,
            );
          }
          if (resumed) {
            expect(saved.sessionId).toBe(expectedSessionId);
            expect(saved.goal?.id).toBe(noGoal ? undefined : expectedGoalId);
            if (!noGoal) {
              expect(saved.mainRestartRecovery?.goalIntent?.issuer.profileId).toBe(profile.id);
            }
          } else if (
            change !== "late role revoke" &&
            change !== "wrong repository" &&
            change !== "late repository replaced" &&
            change !== "broker lease missing" &&
            change !== "broker actor changed"
          ) {
            expect(saved.mainRestartRecovery?.chargedAttempts ?? 0, change).toBe(0);
          }
          if (activeGoalAccepted && !resumed) {
            await assertInterruptedOriginalInput(currentTarget);
          }
          if (factoryRepository) {
            if (resumed) {
              expect(repositoryFixture!.proofs.size).toBeGreaterThan(beforeProofs);
              expect(repositoryFixture!.fetchFixture.mock.calls.length).toBeGreaterThan(beforeHttp);
              if (!noGoal) {
                expect(saved.mainRestartRecovery?.goalIntent?.issuer.factoryActor).toEqual({
                  host: "microsoft.ghe.com",
                  accountId: expectedActorId,
                });
              }
            } else {
              expect(repositoryFixture!.fetchFixture.mock.calls.length).toBe(beforeHttp);
            }
          }
          if (change === "terminal error") {
            expect(saved.goal?.status).toBe("paused");
            expect(saved.goalPauseOrigin).toBe("terminal-error");
            expect(saved.mainRestartRecovery?.goalIntent?.issuer.profileId).toBe(profile.id);
          }
          if (change === "manual pause") {
            expect(saved.goalPauseOrigin).toBe("manual");
          }
          if (change === "budget exhausted") {
            expect(saved.goal?.status).toBe("budget_limited");
          }
          if (change === "unknown effect") {
            expect(saved.mainRestartRecovery?.pause?.reason).toBe("unverifiable-external-effect");
          }
          const restoredHistory = await readIssuerFixtureHistory(currentTarget, saved.sessionId);
          if (change !== "SID changed") {
            expect(restoredHistory.slice(0, history.length), change).toEqual(history);
          }
          if (noGoal && resumed) {
            await markStartupOrphanedMainSessionsForRecovery({ cfg, stateDir: state.stateDir });
            const repeated = await recoverRestartAbortedMainSessions({
              cfg,
              stateDir: state.stateDir,
              gatewayRuntime: nextRuntime.recovery,
            });
            expect(repeated.started + repeated.settled).toBe(0);
            expect(effectCount - beforeEffects).toBe(1);
          }
        } finally {
          await startup?.stop();
          restorePlanning();
          revokeBeforeCommit?.mockRestore();
          observer.mockRestore();
          warnings.mockRestore();
          await clearSessionGoal(currentTarget);
          nextRuntime.close();
          closeGatewayDeviceRevocation(nextContext);
          await work.drain();
        }
      }
    } finally {
      execution.mockRestore();
      restoreActivePluginRegistrySnapshot(registrySnapshot);
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });
}
