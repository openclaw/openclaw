import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { getRuntimeConfig } from "../../../config/config.js";
import { bindInProcessSessionRun } from "../../../gateway/in-process-session-run.js";
import { ADMIN_SCOPE } from "../../../gateway/method-scopes.js";
import type { GatewayContextResolver } from "../../../gateway/server-methods/types.js";
import { measureStartup, type GatewayStartupTrace } from "../../../gateway/server-startup-trace.js";
import {
  getAgentEventLifecycleGeneration,
  isAgentEventLifecycleGenerationCurrent,
} from "../../../infra/agent-events.js";
import { getGatewayContextResolver as getEntryGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import {
  runWithGatewayIndependentRootWorkAdmission,
  GatewayDrainingError,
} from "../../../process/gateway-work-admission.js";
import { emitSessionLifecycleEvent } from "../../../sessions/session-lifecycle-events.js";
import { createLazyRuntimeModule } from "../../../shared/lazy-runtime.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import { decodeRequesterOrigin } from "../../requester-origin.js";
import { reserveRestoredSubagentControllerSources } from "../announce/subagent-announce-controller-source.js";
import { applySubagentLaunchAuthorization } from "../spawn/subagent-launch-authorization.js";
import { readGatewayRunId } from "../spawn/subagent-spawn-gateway.js";
import { resolveSwarmConfig } from "../swarm/swarm-config.js";
import { bindSwarmRunReservation, enqueueSwarmRun } from "../swarm/swarm-scheduler.js";
import {
  resolveSubagentChildAgentId,
  resolveSubagentChildAuthority,
  warnLegacySubagentAuthority,
} from "./subagent-child-owner-match.js";
import { shouldSuppressSubagentRecoverySessionEffects } from "./subagent-recovery-state.js";
import { callSubagentRegistryGateway } from "./subagent-registry-deps.js";
import {
  getCurrentSubagentRunOwner,
  waitForSubagentRetirementPublication,
} from "./subagent-registry-memory.js";
import {
  assertSubagentRegistryWriteSourceCurrent,
  mutateSubagentRuns,
  restoreSubagentRunsFromDisk,
} from "./subagent-registry-persistence.js";
import type { createSubagentRegistryPublicApi } from "./subagent-registry-public-api.js";
import { getLatestSubagentRunForChild } from "./subagent-registry-queries.js";
import { isRetiredSubagentSessionOwner } from "./subagent-registry-restart-recovery-helpers.js";
import { restoreSubagentRunMetadata } from "./subagent-registry-restore-metadata.js";
import { createRestoredRequesterActivator } from "./subagent-registry-restore-requester.js";
import type { SubagentLaunchManager } from "./subagent-registry-run-launch.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { getSubagentRunRuntimeKey, isSameSubagentRunOwner } from "./subagent-run-generation.js";
import { deleteSubagentSessionForCleanup } from "./subagent-session-cleanup.js";
import { loadSubagentSessionEntry } from "./subagent-session-reconciliation.js";

const loadOperatorRecovery = createLazyRuntimeModule(
  () => import("../../../gateway/operator-run-recovery.js"),
);

const restoredQueuedFailureSettlementClaims = new WeakSet<object>();

export function isRestoredQueuedFailureSettlementClaimed(entry: SubagentRunRecord): boolean {
  return restoredQueuedFailureSettlementClaims.has(getSubagentRunRuntimeKey(entry));
}

export function createSubagentRegistryRestorer(config: {
  runs: Map<string, SubagentRunRecord>;
  getGatewayContextResolver: () => GatewayContextResolver | undefined;
  bindGatewayOwners: Parameters<typeof createRestoredRequesterActivator>[0]["bindGatewayOwners"];
  settleRequesterTurn: Parameters<
    typeof createRestoredRequesterActivator
  >[0]["settleRequesterTurn"];
  retireSupersededRun: Parameters<
    typeof createRestoredRequesterActivator
  >[0]["retireSupersededRun"];
  ensureListener: () => void;
  startSweeper: () => void;
  scheduleSweep: () => void;
  recoverInterruptedRuns: Parameters<
    typeof createRestoredRequesterActivator
  >[0]["recoverInterruptedRuns"];
  resumeRun: (runId: string) => void;
  listSwarmRunsForGroup: ReturnType<
    typeof createSubagentRegistryPublicApi
  >["listSwarmRunsForGroup"];
  startQueuedSubagentRun: SubagentLaunchManager["startQueuedSubagentRun"];
  terminateAcceptedRestoredCollectorRun: (params: {
    entry: SubagentRunRecord;
    gatewayRunId: string;
    timeoutMs: number;
    expectedSessionId?: string;
    expectedLifecycleRevision?: string;
  }) => Promise<void>;
  cleanupCollectorLaunchResources: (
    entry: SubagentRunRecord,
    options?: { isCurrent?: () => boolean },
  ) => Promise<boolean>;
  settleFailedQueuedSubagentLaunch: SubagentLaunchManager["settleFailedQueuedSubagentLaunch"];
  completeCollectorLaunchCleanup: (runId: string) => Promise<void>;
  warn: (message: string, meta?: Record<string, unknown>) => void;
}) {
  const { runs, getGatewayContextResolver, bindGatewayOwners } = config;
  const { settleRequesterTurn, ensureListener, startSweeper } = config;
  const { scheduleSweep, resumeRun, warn } = config;
  const { listSwarmRunsForGroup, startQueuedSubagentRun } = config;
  const { terminateAcceptedRestoredCollectorRun, cleanupCollectorLaunchResources } = config;
  const { settleFailedQueuedSubagentLaunch, completeCollectorLaunchCleanup } = config;
  let restoreState: "idle" | "succeeded" = "idle";
  let activationRequested = false;
  let activated = false;
  let restoreInFlight: Promise<void> | undefined;
  let activationInFlight: Promise<void> | undefined;
  // A later explicit restore must reconcile rows merged before an earlier failure.
  let restoredRowsPending = false;
  const requesterActivator = createRestoredRequesterActivator({
    runs,
    bindGatewayOwners,
    settleRequesterTurn,
    retireSupersededRun: config.retireSupersededRun,
    resumeRuns: resumeRestoredRuns,
    recoverInterruptedRuns: config.recoverInterruptedRuns,
  });

  async function completeRestore() {
    restoredRowsPending = false;
    restoreState = "succeeded";
    if (activationRequested) {
      await activateRestoredRuns();
    }
  }

  function activateRestoredRuns(startupTrace?: GatewayStartupTrace): Promise<void> {
    if (activationInFlight) {
      return activationInFlight;
    }
    const operation = activateRestoredRunsOnce(startupTrace);
    activationInFlight = operation;
    void operation.then(clearActivation, clearActivation);
    function clearActivation() {
      if (activationInFlight === operation) {
        activationInFlight = undefined;
      }
    }
    return operation;
  }

  async function activateRestoredRunsOnce(startupTrace?: GatewayStartupTrace) {
    activationRequested = true;
    if (restoreState !== "succeeded" || !getGatewayContextResolver()?.()) {
      return;
    }
    const stateContext = captureOpenClawStateWorkerContext();
    const resolver = getGatewayContextResolver();
    const gateway = resolver?.();
    const assertCurrent = () => {
      assertSubagentRegistryWriteSourceCurrent(stateContext);
      if (getGatewayContextResolver() !== resolver || !gateway || resolver?.() !== gateway) {
        throw new Error("Restored requester transfer lost its Gateway owner");
      }
    };
    const { resumeNeeded, failures } = await requesterActivator.activate({
      cfg: getRuntimeConfig(),
      stateContext,
      assertCurrent,
      startupTrace,
      alreadyActivated: activated,
    });
    assertCurrent();
    // Keep the periodic sweep behind restore while healthy groups recover above.
    if (resumeNeeded && runs.size > 0) {
      startSweeper();
    }
    scheduleSweep();
    if (failures.length > 0) {
      throw failures[0];
    }
    activated = true;
    requesterActivator.reset();
  }

  async function resumeRestoredRuns(
    capturedRuns: readonly SubagentRunRecord[],
    assertCurrent: () => void,
    startupTrace?: GatewayStartupTrace,
  ) {
    await measureStartup(startupTrace, "sidecars.subagent-reserve", () =>
      reserveRestoredSubagentControllerSources(capturedRuns),
    );
    assertCurrent();
    if (runs.size === 0) {
      return;
    }
    ensureListener();
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const assertReadCurrent = () => {
      assertCurrent();
      if (!isAgentEventLifecycleGenerationCurrent(lifecycleGeneration)) {
        throw new Error("Restored subagent read lost its Gateway lifecycle");
      }
    };
    let sessionReadMs = 0;
    try {
      for (const snapshot of capturedRuns) {
        const runId = snapshot.runId;
        const selected = getCurrentSubagentRunOwner(runs, snapshot);
        // Recovery and cancellation prepare their own session reads.
        if (
          !selected ||
          selected.runId !== runId ||
          resolveSubagentChildAuthority(selected).status === "mismatch" ||
          selected.execution.restartRecovery ||
          selected.killIntent ||
          selected.killReconciliation
        ) {
          continue;
        }
        assertReadCurrent();
        // Terminal delivery has its own session checks; startup only reconciles unfinished runs.
        let sessionEntry: Awaited<ReturnType<typeof loadSubagentSessionEntry>>;
        if (typeof selected.execution.endedAt !== "number") {
          const beforeRead = performance.now();
          try {
            sessionEntry = await loadSubagentSessionEntry({
              childSessionKey: selected.childSessionKey,
              childAgentId: selected.childAgentId,
              assertCurrent: assertReadCurrent,
            });
          } finally {
            sessionReadMs += performance.now() - beforeRead;
          }
        }
        assertReadCurrent();
        const entry = getCurrentSubagentRunOwner(runs, snapshot);
        if (!entry || entry.runId !== runId) {
          continue;
        }
        // Restart recovery and accepted cancellation own their rows independently.
        if (entry.execution.restartRecovery || entry.killIntent || entry.killReconciliation) {
          continue;
        }
        const authority = resolveSubagentChildAuthority(entry, sessionEntry);
        if (authority.status === "mismatch") {
          continue;
        }
        if (entry.collect && entry.execution.status === "queued") {
          const { childSessionIdentity: cleanupSessionEntry, queuedLaunch: launch } = entry;
          if (!launch || authority.status === "legacy-unverified") {
            void failAndCleanupRestoredQueuedRun(
              entry,
              !launch
                ? "queued collector launch state was unavailable after restart"
                : "queued collector original session identity was unavailable after restart; launch was not resumed",
              getAgentEventLifecycleGeneration(),
              cleanupSessionEntry?.sessionId,
              cleanupSessionEntry?.lifecycleRevision,
            ).catch((cleanupError: unknown) => {
              warn("failed to settle restored collector launch failure", {
                runId,
                childSessionKey: entry.childSessionKey,
                error: cleanupError,
              });
            });
            continue;
          }
          const groupId = entry.groupId ?? "";
          const requesterSessionKey = entry.swarmRequesterSessionKey ?? entry.requesterSessionKey;
          let pendingLaunchTermination: string | undefined;
          let launchLifecycleGeneration: string | undefined;
          enqueueSwarmRun({
            // Global session keys repeat across agent stores, including restored queues.
            groupId: JSON.stringify([entry.requesterAgentId, requesterSessionKey, groupId]),
            runId,
            maxConcurrent: resolveSwarmConfig(getRuntimeConfig(), entry.requesterAgentId)
              .maxConcurrent,
            activeRunIds: listSwarmRunsForGroup(
              groupId,
              requesterSessionKey,
              entry.requesterAgentId,
            )
              .filter(
                (candidate) =>
                  candidate.execution.status === "running" ||
                  candidate.execution.status === "interrupted",
              )
              .map((candidate) => candidate.schedulerSlotId ?? candidate.runId),
            start: async () => {
              await runWithGatewayIndependentRootWorkAdmission(async () => {
                const { MAX_RECOVERY_SOURCE_BYTES } =
                  await import("../../../gateway/operator-run-recovery-source.codec.js");
                assertCurrent();
                const launchEntry = runs.get(runId);
                if (
                  !launchEntry ||
                  !isSameSubagentRunOwner(launchEntry, entry) ||
                  launchEntry.execution.status !== "queued" ||
                  launchEntry.killIntent ||
                  launchEntry.killReconciliation
                ) {
                  throw new Error("Restored collector launch lost its queued owner");
                }
                const launchGeneration = getAgentEventLifecycleGeneration();
                launchLifecycleGeneration = launchGeneration;
                const requesterRecovery = launch.requesterRecovery;
                if (!isRecord(requesterRecovery)) {
                  throw new Error(
                    "Queued requester recovery source is unavailable; submit a new request.",
                  );
                }
                if (
                  requesterRecovery.facts === null ||
                  (requesterRecovery.facts !== undefined &&
                    Buffer.byteLength(JSON.stringify(requesterRecovery.facts), "utf8") >
                      MAX_RECOVERY_SOURCE_BYTES)
                ) {
                  throw new Error(
                    "Queued requester identity could not be retained; submit a new request.",
                  );
                }
                const requesterFacts =
                  requesterRecovery.facts === undefined
                    ? undefined
                    : decodeRequesterOrigin(requesterRecovery.facts);
                if (requesterRecovery.facts !== undefined && !requesterFacts) {
                  throw new Error("Queued requester identity is invalid; submit a new request.");
                }
                const capturedRequesterRecovery = structuredClone(requesterRecovery);
                const gatewayContext = getGatewayContextResolver()?.();
                const gatewayRuntime = gatewayContext?.recoveryRuntime;
                if (!gatewayContext || !gatewayRuntime) {
                  throw new GatewayDrainingError();
                }
                let accepted = false;
                const assertLaunchCurrent = () => {
                  assertCurrent();
                  if (
                    !isAgentEventLifecycleGenerationCurrent(launchGeneration) ||
                    getGatewayContextResolver()?.() !== gatewayContext
                  ) {
                    throw new Error("Restored collector launch lost its Gateway lifecycle");
                  }
                  // The accepted execution owns its lifetime; clearing queuedLaunch is not revocation.
                  if (accepted) {
                    return;
                  }
                  const current = getCurrentSubagentRunOwner(runs, entry);
                  if (
                    !current ||
                    current.killIntent ||
                    current.killReconciliation ||
                    !current.queuedLaunch ||
                    !isDeepStrictEqual(
                      current.queuedLaunch.requesterRecovery,
                      capturedRequesterRecovery,
                    ) ||
                    (current.execution.status !== "queued" &&
                      !(current.execution.status === "running" && current.swarmLaunchPending) &&
                      current.collectorCompletion === undefined)
                  ) {
                    throw new Error("Restored collector launch lost its queued owner");
                  }
                };
                assertLaunchCurrent();
                const request = bindInProcessSessionRun(
                  {
                    ...applySubagentLaunchAuthorization(launch.request, launch.authorization),
                    agentId: authority.childAgentId,
                  },
                  {
                    sessionKey: entry.childSessionKey,
                    sessionId: authority.sessionIdentity.sessionId,
                    lifecycleRevision: authority.sessionIdentity.lifecycleRevision,
                    runId,
                  },
                );
                const operator =
                  requesterRecovery.operator !== undefined
                    ? await (
                        await loadOperatorRecovery()
                      ).restoreGatewayQueuedOperatorRecovery({
                        source: requesterRecovery.operator,
                        context: gatewayContext,
                        assertCurrent: assertLaunchCurrent,
                      })
                    : undefined;
                let response: unknown;
                try {
                  assertLaunchCurrent();
                  if (requesterFacts && !authority.requesterAgentId) {
                    throw new Error("Queued requester agent is unavailable; submit a new request.");
                  }
                  response = await gatewayRuntime.dispatchAgent(
                    request as Parameters<typeof gatewayRuntime.dispatchAgent>[0],
                    launch.timeoutMs,
                    {
                      ...(launch.authorization
                        ? { allowModelOverride: true, scopes: [ADMIN_SCOPE] }
                        : {}),
                      operatorRunAuthority: operator?.authority,
                      agentToolCaller:
                        requesterFacts && authority.requesterAgentId
                          ? {
                              agentId: authority.requesterAgentId,
                              sessionKey: entry.requesterSessionKey,
                              requesterOrigin: requesterFacts,
                              assertCurrent: assertLaunchCurrent,
                            }
                          : undefined,
                      assertAdmissionCurrent: assertLaunchCurrent,
                    },
                  );
                  // The acceptance-returning dispatch has transferred work to its execution owner.
                  accepted = true;
                } finally {
                  operator?.release();
                }
                const gatewayRunId = readGatewayRunId(response) ?? runId;
                try {
                  if (!getCurrentSubagentRunOwner(runs, entry)) {
                    throw new Error("Restored collector launch owner changed before publication");
                  }
                  if (
                    !(await startQueuedSubagentRun(runId, gatewayRunId, launchLifecycleGeneration))
                  ) {
                    throw new Error(
                      "collector registry row could not transition from queued to running",
                    );
                  }
                } catch (error) {
                  // Keep accepted rollback in failure settlement, where retirement
                  // publication can finish before provisional-session deletion.
                  pendingLaunchTermination = gatewayRunId;
                  throw error;
                }
              }, "subagents:restore-launch");
            },
            onStartFailure: async (error) => {
              if (error instanceof GatewayDrainingError) {
                return false;
              }
              for (
                let publication = waitForSubagentRetirementPublication(entry);
                publication;
                publication = waitForSubagentRetirementPublication(entry)
              ) {
                await publication;
              }
              if (pendingLaunchTermination) {
                await terminateAcceptedRestoredCollectorRun({
                  entry,
                  gatewayRunId: pendingLaunchTermination,
                  timeoutMs: launch.timeoutMs,
                  expectedSessionId: cleanupSessionEntry?.sessionId,
                  expectedLifecycleRevision: cleanupSessionEntry?.lifecycleRevision,
                });
              }
              return failAndCleanupRestoredQueuedRun(
                entry,
                error instanceof Error ? error.message : String(error),
                launchLifecycleGeneration ?? getAgentEventLifecycleGeneration(),
                cleanupSessionEntry?.sessionId,
                cleanupSessionEntry?.lifecycleRevision,
              );
            },
          });
          bindSwarmRunReservation(
            entry.schedulerSlotId ?? runId,
            getSubagentRunRuntimeKey(entry),
            () => {
              const current = getCurrentSubagentRunOwner(runs, entry);
              if (current) {
                emitSessionLifecycleEvent({
                  sessionKey: current.childSessionKey,
                  reason: "run-capacity",
                });
              }
            },
          );
          continue;
        }
        // Orphan recovery owns aborted sessions and exact still-running retired
        // executions. Completed sessions must resume normal settlement and delivery.
        if (
          sessionEntry?.abortedLastRun === true ||
          isRetiredSubagentSessionOwner(entry, sessionEntry)
        ) {
          continue;
        }
        resumeRun(runId);
      }
    } finally {
      startupTrace?.detail("sidecars.subagent-activation", [
        ["registryActivationSessionReadMs", sessionReadMs],
      ]);
    }
  }

  function restoreSubagentRunsOnce(
    throwOnError = false,
    stateContext = captureOpenClawStateWorkerContext(),
  ): Promise<void> {
    if (restoreInFlight) {
      return throwOnError ? restoreInFlight : restoreInFlight.catch(() => {});
    }
    if (restoreState === "succeeded") {
      return Promise.resolve();
    }
    const assertCurrent = () => {
      assertSubagentRegistryWriteSourceCurrent(stateContext);
    };
    const runCountBeforeRestore = runs.size;
    const operation = Promise.resolve().then(async () => {
      try {
        const restoredCount = await restoreSubagentRunsFromDisk({
          runs,
          mergeOnly: true,
          context: stateContext,
          assertCurrent,
        });
        assertCurrent();
        restoredRowsPending ||= restoredCount > 0;
        if (restoredRowsPending) {
          await restoreSubagentRunMetadata(runs, stateContext, assertCurrent);
          assertCurrent();
        }
        warnLegacySubagentAuthority(runs.values(), warn);
        await completeRestore();
      } catch (err) {
        if (restoreState !== "succeeded") {
          restoredRowsPending ||= runs.size > runCountBeforeRestore;
        }
        warn(
          `failed to restore subagent runs from disk: ${err instanceof Error ? err.message : String(err)}`,
        );
        throw err;
      }
    });
    restoreInFlight = operation;
    void operation.then(clearRestore, clearRestore);
    function clearRestore() {
      if (restoreInFlight === operation) {
        restoreInFlight = undefined;
      }
    }
    return throwOnError ? operation : operation.catch(() => {});
  }

  function failAndCleanupRestoredQueuedRun(
    entry: SubagentRunRecord,
    error: string,
    lifecycleGeneration: string,
    expectedSessionId?: string,
    expectedLifecycleRevision?: string,
  ): Promise<boolean> {
    const runId = entry.runId;
    const warnCleanup = (message: string, failure: unknown) =>
      warn(message, { runId, childSessionKey: entry.childSessionKey, error: failure });
    // Root custody includes the terminal commit and final cleanup publication.
    return runWithGatewayIndependentRootWorkAdmission(async () => {
      const authority = resolveSubagentChildAuthority(entry);
      if (authority.status === "mismatch") {
        return false;
      }
      // Descriptorless restore failures enter here without onStartFailure; their
      // provisional session must survive the same pending cancellation receipt.
      for (
        let publication = waitForSubagentRetirementPublication(entry);
        publication;
        publication = waitForSubagentRetirementPublication(entry)
      ) {
        await publication;
      }
      const identity = getSubagentRunRuntimeKey(entry);
      const currentEntry = () => runs.get(runId);
      const ownsQueuedRun = (current = currentEntry()): current is SubagentRunRecord =>
        isSameSubagentRunOwner(current, entry) && current?.execution.status === "queued";
      if (!ownsQueuedRun()) {
        return true;
      }
      restoredQueuedFailureSettlementClaims.add(identity);
      const ownsClaim = () => {
        const current = currentEntry();
        return ownsQueuedRun(current) && !current.killIntent && !current.killReconciliation;
      };
      const ownsSessionEffects = () => {
        const current = currentEntry();
        return (
          current !== undefined &&
          authority.status === "verified" &&
          isSameSubagentRunOwner(current, entry) &&
          isAgentEventLifecycleGenerationCurrent(lifecycleGeneration) &&
          !shouldSuppressSubagentRecoverySessionEffects(current) &&
          isSameSubagentRunOwner(getLatestSubagentRunForChild(runs, entry), entry)
        );
      };
      const suppressRetiredSessionEffects = () =>
        mutateSubagentRuns(
          [runId],
          (rows) => {
            const current = rows.get(runId);
            if (
              !current ||
              !isSameSubagentRunOwner(current, entry) ||
              ownsSessionEffects() ||
              current.execution.suppressSessionEffects === true
            ) {
              return { value: undefined };
            }
            return {
              value: undefined,
              postimages: new Map([
                [
                  runId,
                  {
                    ...current,
                    execution: { ...current.execution, suppressSessionEffects: true },
                  },
                ],
              ]),
            };
          },
          { runs },
        );
      const ownsCleanup = () => ownsClaim() && ownsSessionEffects();
      let sessionCleanup: Awaited<ReturnType<typeof deleteSubagentSessionForCleanup>> | undefined;
      try {
        const cleanupComplete = await (async () => {
          if (authority.status === "legacy-unverified") {
            return true;
          }
          if (!ownsCleanup()) {
            return false;
          }
          if (!expectedSessionId || !expectedLifecycleRevision) {
            sessionCleanup = "changed";
            return true;
          }
          sessionCleanup = await deleteSubagentSessionForCleanup({
            callGateway: callSubagentRegistryGateway,
            gatewayBinding: { resolveGatewayContext: getEntryGatewayContextResolver(entry) },
            isCurrent: ownsCleanup,
            childSessionKey: entry.childSessionKey,
            childAgentId: resolveSubagentChildAgentId(entry),
            expectedSessionId,
            expectedLifecycleRevision,
            onError: (cleanupError) => {
              throw cleanupError;
            },
          });
          if (!ownsCleanup() || sessionCleanup === "changed") {
            return ownsCleanup();
          }
          return await cleanupCollectorLaunchResources(entry, { isCurrent: ownsCleanup });
        })().catch((cleanupError: unknown) => {
          warnCleanup("failed to clean restored collector after launch failure", cleanupError);
          return false;
        });

        if (!ownsClaim()) {
          return !ownsQueuedRun();
        }
        await suppressRetiredSessionEffects();
        if (!ownsClaim()) {
          return false;
        }
        const failureSettled = await settleFailedQueuedSubagentLaunch(runId, error);
        if (!failureSettled) {
          return !ownsQueuedRun();
        }
        await suppressRetiredSessionEffects();
        if (cleanupComplete && isSameSubagentRunOwner(currentEntry(), entry)) {
          if (sessionCleanup === "deleted") {
            emitSessionLifecycleEvent({
              sessionKey: entry.childSessionKey,
              reason: "delete",
              parentSessionKey: entry.swarmRequesterSessionKey ?? entry.requesterSessionKey,
            });
          }
          await completeCollectorLaunchCleanup(runId);
        }
        return true;
      } finally {
        restoredQueuedFailureSettlementClaims.delete(identity);
      }
    }, "subagents:restore-cleanup");
  }

  return {
    restoreOnce: restoreSubagentRunsOnce,
    activate: activateRestoredRuns,
    // Old sweepers and reopened admission must wait for restored inventory and its Gateway.
    canResumeWakes: () =>
      !activationRequested ||
      (restoreState === "succeeded" && Boolean(getGatewayContextResolver()?.())),
    reset: () => {
      restoreState = "idle";
      restoredRowsPending = false;
      activationRequested = false;
      activated = false;
      requesterActivator.reset();
    },
  };
}
