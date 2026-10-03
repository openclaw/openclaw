import { getRuntimeConfig } from "../../../config/config.js";
import { ADMIN_SCOPE } from "../../../gateway/method-scopes.js";
import type { GatewayContextResolver } from "../../../gateway/server-methods/types.js";
import {
  getAgentEventLifecycleGeneration,
  isAgentEventLifecycleGenerationCurrent,
} from "../../../infra/agent-events.js";
import {
  bindGatewayContextResolver,
  getGatewayContextResolver as getEntryGatewayContextResolver,
} from "../../../plugins/runtime/gateway-request-scope.js";
import {
  runWithGatewayIndependentRootWorkAdmission,
  GatewayDrainingError,
} from "../../../process/gateway-work-admission.js";
import { emitSessionLifecycleEvent } from "../../../sessions/session-lifecycle-events.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import { resolveSubagentRequesterAgentId } from "../../subagent-requester-owner.js";
import { applySubagentLaunchAuthorization } from "../spawn/subagent-launch-authorization.js";
import { retrySubagentCleanup } from "../spawn/subagent-spawn-cleanup.js";
import { readGatewayRunId } from "../spawn/subagent-spawn-gateway.js";
import { resolveSwarmConfig } from "../swarm/swarm-config.js";
import { bindSwarmRunReservation, enqueueSwarmRun } from "../swarm/swarm-scheduler.js";
import { shouldSuppressSubagentRecoverySessionEffects } from "./subagent-recovery-state.js";
import { callSubagentRegistryGateway } from "./subagent-registry-deps.js";
import { updateSubagentArchiveAtMs } from "./subagent-registry-helpers.js";
import type { SubagentLifecycleController } from "./subagent-registry-lifecycle.js";
import {
  getCurrentSubagentRunOwner,
  subagentRuns,
  waitForSubagentRetirementPublication,
} from "./subagent-registry-memory.js";
import {
  assertSubagentRegistryWriteSourceCurrent,
  mutateSubagentRuns,
  restoreSubagentRunsFromDisk,
  SubagentRegistryMutationRejectedError,
} from "./subagent-registry-persistence.js";
import { getLatestSubagentRunForChild } from "./subagent-registry-queries.js";
import { isRetiredSubagentSessionOwner } from "./subagent-registry-restart-recovery-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { getSubagentRunRuntimeKey, isSameSubagentRunOwner } from "./subagent-run-generation.js";
import { deleteSubagentSessionForCleanup } from "./subagent-session-cleanup.js";
import { loadSubagentSessionEntry } from "./subagent-session-reconciliation.js";

const restoredQueuedFailureSettlementClaims = new WeakMap<object, object>();

const RESTORE_RETRY_DELAY_MS = 1_000;
const RESTORE_RETRY_MAX_DELAY_MS = 30_000;

/** Retirement publications can chain; settle every one before touching the row. */
async function drainRetirementPublications(entry: SubagentRunRecord): Promise<void> {
  for (
    let publication = waitForSubagentRetirementPublication(entry);
    publication;
    publication = waitForSubagentRetirementPublication(entry)
  ) {
    await publication;
  }
}

export function isRestoredQueuedFailureSettlementClaimed(entry: SubagentRunRecord): boolean {
  return restoredQueuedFailureSettlementClaims.has(getSubagentRunRuntimeKey(entry));
}

/** A closed Gateway's durable terminal wake acquires fresh host custody, never its old aliases. */
export async function recoverSubagentRunGatewayOwner(
  expected: SubagentRunRecord,
  resolver: GatewayContextResolver,
  onRecovered: (entry: SubagentRunRecord) => void,
): Promise<boolean> {
  const previousResolver = getEntryGatewayContextResolver(expected);
  const gateway = resolver();
  if (!previousResolver || previousResolver() !== undefined || !gateway) {
    return false;
  }
  return mutateSubagentRuns(
    [expected.runId],
    (rows) => {
      const current = rows.get(expected.runId);
      if (!current) {
        throw new SubagentRegistryMutationRejectedError(
          "Subagent Gateway recovery row disappeared",
        );
      }
      return { value: true, postimages: new Map([[current.runId, structuredClone(current)]]) };
    },
    {
      gatewayRecovery: { expected, previousResolver, resolver, gateway },
      onPublished: (postimages) => {
        const row = postimages.get(expected.runId);
        if (row) {
          bindGatewayContextResolver(row, resolver);
          onRecovered(row);
          subagentRuns.commitOwnership(row);
        }
      },
    },
  );
}

export function createSubagentRegistryRestorer(config: {
  runs: Map<string, SubagentRunRecord>;
  getGatewayContextResolver: () => GatewayContextResolver | undefined;
  bindGatewayOwners: () => boolean | Promise<boolean>;
  settleRequesterTurn: SubagentLifecycleController["settleRequesterTurnAfterSessionSpawns"];
  ensureListener: () => void;
  startSweeper: () => void;
  scheduleSweep: () => void;
  resumeRun: (runId: string) => void;
  listSwarmRunsForGroup: (
    groupId: string,
    requesterSessionKey?: string,
    requesterAgentId?: string,
  ) => SubagentRunRecord[];
  startQueuedSubagentRun: (
    runId: string,
    gatewayRunId?: string,
    lifecycleGeneration?: string,
  ) => Promise<boolean>;
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
  settleFailedQueuedSubagentLaunch: (runId: string, error: string) => Promise<boolean>;
  completeCollectorLaunchCleanup: (runId: string) => Promise<void>;
  warn: (message: string, meta?: Record<string, unknown>) => void;
}) {
  const {
    runs,
    getGatewayContextResolver,
    bindGatewayOwners,
    settleRequesterTurn,
    ensureListener,
    startSweeper,
    scheduleSweep,
    resumeRun,
    listSwarmRunsForGroup,
    startQueuedSubagentRun,
    terminateAcceptedRestoredCollectorRun,
    cleanupCollectorLaunchResources,
    settleFailedQueuedSubagentLaunch,
    completeCollectorLaunchCleanup,
    warn,
  } = config;
  let restoreState: "idle" | "in-progress" | "succeeded" = "idle";
  let activationRequested = false;
  let activated = false;
  let restoreInFlight: Promise<void> | undefined;
  let activationInFlight: Promise<void> | undefined;
  let generation = 0;
  // A dependency can merge rows before throwing. Keep their reconciliation
  // pending because mergeOnly correctly reports them as existing on retry.
  let restoredRowsPending = false;
  let restoreRetryTimer: ReturnType<typeof setTimeout> | undefined;

  function clearRestoreRetryTimer() {
    if (restoreRetryTimer) {
      clearTimeout(restoreRetryTimer);
      restoreRetryTimer = undefined;
    }
  }

  function scheduleRestoreRetry(delayMs: number) {
    if (restoreRetryTimer) {
      return;
    }
    const timer = setTimeout(() => {
      if (restoreRetryTimer !== timer) {
        return;
      }
      restoreRetryTimer = undefined;
      void restoreSubagentRunsOnce(Math.min(delayMs * 2, RESTORE_RETRY_MAX_DELAY_MS));
    }, delayMs);
    restoreRetryTimer = timer;
    timer.unref?.();
  }

  async function completeRestore() {
    restoredRowsPending = false;
    restoreState = "succeeded";
    clearRestoreRetryTimer();
    if (activationRequested) {
      await activateRestoredRuns();
    }
  }

  function activateRestoredRuns(): Promise<void> {
    if (activationInFlight) {
      return activationInFlight;
    }
    const operation = activateRestoredRunsOnce();
    activationInFlight = operation;
    void operation.then(clearActivation, clearActivation);
    function clearActivation() {
      if (activationInFlight === operation) {
        activationInFlight = undefined;
      }
    }
    return operation;
  }

  async function activateRestoredRunsOnce() {
    activationRequested = true;
    const originalGeneration = generation;
    // Hydration retries can finish after Gateway activation or closure. Bind before
    // resuming, including repeat activations, and leave closed-instance rows pending.
    if (
      restoreState !== "succeeded" ||
      !(await bindGatewayOwners()) ||
      generation !== originalGeneration
    ) {
      return;
    }
    // Post-ready only: collector cleanup retains the canonical sessions.delete RPC owner.
    scheduleSweep();
    if (activated) {
      return;
    }
    const stateContext = captureOpenClawStateWorkerContext();
    const resolver = getGatewayContextResolver();
    const gateway = resolver?.();
    const assertCurrent = () => {
      assertSubagentRegistryWriteSourceCurrent(stateContext);
      if (
        generation !== originalGeneration ||
        getGatewayContextResolver() !== resolver ||
        !gateway ||
        resolver?.() !== gateway
      ) {
        throw new Error("Restored requester transfer lost its Gateway owner");
      }
    };
    const cfg = getRuntimeConfig();
    const requesterTurns = new Map<string, Map<string, SubagentRunRecord[]>>();
    const resolveRequesterAgentId = (entry: SubagentRunRecord) =>
      resolveSubagentRequesterAgentId(cfg, entry);
    for (const entry of runs.values()) {
      const requesterTurnRunId = entry.requesterTurnRunId?.trim();
      if (!requesterTurnRunId || entry.expectsCompletionMessage !== true) {
        continue;
      }
      const requesterIdentity = `${resolveRequesterAgentId(entry) ?? "unknown"}\0${entry.requesterSessionKey}`;
      let turns = requesterTurns.get(requesterIdentity);
      if (!turns) {
        turns = new Map();
        requesterTurns.set(requesterIdentity, turns);
      }
      const entries = turns.get(requesterTurnRunId) ?? [];
      entries.push(entry);
      turns.set(requesterTurnRunId, entries);
    }
    for (const [, turns] of requesterTurns) {
      for (const [requesterTurnRunId, entries] of turns) {
        const firstEntry = entries[0];
        if (!firstEntry) {
          continue;
        }
        assertCurrent();
        await settleRequesterTurn(
          {
            requesterSessionKey: firstEntry.requesterSessionKey,
            stateContext,
            assertCurrent,
            requesterAgentId: resolveRequesterAgentId(firstEntry),
            requesterTurnRunId,
            requesterYielded: entries.every((entry) => entry.requesterTurnYielded === true),
            acceptedSessionSpawns: entries.map((entry) => ({
              runId: entry.taskRunId ?? entry.runId,
              childSessionKey: entry.childSessionKey,
            })),
          },
          "restore",
        );
        assertCurrent();
      }
    }
    if (runs.size === 0) {
      activated = true;
      return;
    }

    ensureListener();
    // Session-mode runs have no archive deadline but still need TTL cleanup.
    startSweeper();
    for (const [runId, entry] of runs) {
      // Restart recovery exclusively owns receipt-bearing source rows until it
      // remaps or terminalizes them. Generic resume would wait on an obsolete run.
      if (entry.execution.restartRecovery || entry.killIntent || entry.killReconciliation) {
        continue;
      }
      if (entry.collect && entry.execution.status === "queued") {
        const cleanupSessionEntry = loadSubagentSessionEntry({
          childSessionKey: entry.childSessionKey,
        });
        const launch = entry.queuedLaunch;
        if (!launch) {
          const cleanupLifecycleGeneration = getAgentEventLifecycleGeneration();
          void failAndCleanupRestoredQueuedRun(
            runId,
            entry,
            "queued collector launch state was unavailable after restart",
            false,
            cleanupLifecycleGeneration,
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
        const groupRuns = listSwarmRunsForGroup(
          groupId,
          requesterSessionKey,
          entry.requesterAgentId,
        );
        const currentSwarmConfig = resolveSwarmConfig(cfg, entry.requesterAgentId);
        let launchTerminationConfirmed = false;
        let pendingLaunchTermination: { gatewayRunId: string; error: unknown } | undefined;
        let launchLifecycleGeneration: string | undefined;
        enqueueSwarmRun({
          // Global session keys repeat across agent stores, including restored queues.
          groupId: JSON.stringify([entry.requesterAgentId, requesterSessionKey, groupId]),
          runId,
          maxConcurrent: currentSwarmConfig.maxConcurrent,
          activeRunIds: groupRuns
            .filter(
              (candidate) =>
                candidate.execution.status === "running" ||
                candidate.execution.status === "interrupted",
            )
            .map((candidate) => candidate.schedulerSlotId ?? candidate.runId),
          start: async () => {
            // Once accepted, retries settle this launch rather than dispatching a
            // second agent against a provisional session that cleanup may remove.
            if (pendingLaunchTermination) {
              throw pendingLaunchTermination.error;
            }
            await runWithGatewayIndependentRootWorkAdmission(async () => {
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
              launchLifecycleGeneration = getAgentEventLifecycleGeneration();
              const request = {
                params: applySubagentLaunchAuthorization(launch.request, launch.authorization),
                timeoutMs: launch.timeoutMs,
              };
              const gatewayRuntime = getGatewayContextResolver()?.()?.recoveryRuntime;
              if (!gatewayRuntime) {
                throw new GatewayDrainingError();
              }
              const response = await gatewayRuntime.dispatchAgent(
                request.params as Parameters<typeof gatewayRuntime.dispatchAgent>[0],
                request.timeoutMs,
                launch.authorization
                  ? { allowModelOverride: true, scopes: [ADMIN_SCOPE] }
                  : undefined,
              );
              const gatewayRunId = readGatewayRunId(response) ?? runId;
              try {
                if (!isSameSubagentRunOwner(runs.get(runId), entry)) {
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
                pendingLaunchTermination = { gatewayRunId, error };
                throw error;
              }
            }, "subagents:restore-launch");
          },
          onStartFailure: async (error) => {
            if (error instanceof GatewayDrainingError) {
              return false;
            }
            await drainRetirementPublications(entry);
            if (pendingLaunchTermination && !launchTerminationConfirmed) {
              await terminateAcceptedRestoredCollectorRun({
                entry,
                gatewayRunId: pendingLaunchTermination.gatewayRunId,
                timeoutMs: launch.timeoutMs,
                expectedSessionId: cleanupSessionEntry?.sessionId,
                expectedLifecycleRevision: cleanupSessionEntry?.lifecycleRevision,
              });
              launchTerminationConfirmed = true;
            }
            return failAndCleanupRestoredQueuedRun(
              runId,
              entry,
              error instanceof Error ? error.message : String(error),
              launchTerminationConfirmed,
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
      const sessionEntry = loadSubagentSessionEntry({
        childSessionKey: entry.childSessionKey,
      });
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
    activated = true;
  }

  function restoreSubagentRunsOnce(
    retryDelayMs = RESTORE_RETRY_DELAY_MS,
    throwOnError = false,
    stateContext = captureOpenClawStateWorkerContext(),
  ): Promise<void> {
    if (restoreInFlight) {
      return throwOnError ? restoreInFlight : restoreInFlight.catch(() => {});
    }
    if (restoreState === "succeeded") {
      return Promise.resolve();
    }
    restoreState = "in-progress";
    const originalGeneration = generation;
    const assertCurrent = () => {
      assertSubagentRegistryWriteSourceCurrent(stateContext);
      if (generation !== originalGeneration) {
        throw new Error("Subagent restore owner was retired");
      }
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
        if (!restoredRowsPending) {
          await completeRestore();
          return;
        }
        const cfg = getRuntimeConfig();
        await mutateSubagentRuns(
          [...runs.keys()],
          (rows) => {
            const postimages = new Map<string, SubagentRunRecord>();
            for (const [runId, entry] of rows) {
              const draft = structuredClone(entry);
              const requesterAgentId = resolveSubagentRequesterAgentId(cfg, draft);
              const ownerChanged = !draft.requesterAgentId && requesterAgentId !== undefined;
              if (ownerChanged) {
                draft.requesterAgentId = requesterAgentId;
              }
              if (updateSubagentArchiveAtMs(draft, cfg) || ownerChanged) {
                postimages.set(runId, draft);
              }
            }
            return { value: undefined, postimages };
          },
          { runs, context: stateContext, assertCurrent },
        );
        assertCurrent();
        await completeRestore();
      } catch (err) {
        if (generation === originalGeneration) {
          restoredRowsPending ||= runs.size > runCountBeforeRestore;
          restoreState = "idle";
          warn(
            `failed to restore subagent runs from disk: ${err instanceof Error ? err.message : String(err)}`,
          );
          scheduleRestoreRetry(retryDelayMs);
        }
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
    runId: string,
    entry: SubagentRunRecord,
    error: string,
    launchTerminationConfirmed: boolean,
    lifecycleGeneration: string,
    expectedSessionId?: string,
    expectedLifecycleRevision?: string,
  ): Promise<boolean> {
    // Root custody includes the terminal commit and final cleanup publication.
    return runWithGatewayIndependentRootWorkAdmission(async () => {
      // Descriptorless restore failures enter here without onStartFailure; their
      // provisional session must survive the same pending cancellation receipt.
      await drainRetirementPublications(entry);
      const identity = getSubagentRunRuntimeKey(entry);
      const currentEntry = () => runs.get(runId);
      const ownsQueuedRun = (current = currentEntry()): current is SubagentRunRecord =>
        isSameSubagentRunOwner(current, entry) && current?.execution.status === "queued";
      if (!ownsQueuedRun()) {
        return true;
      }
      const claim = {};
      const launch = JSON.stringify(entry.queuedLaunch);
      const killIntent = JSON.stringify(entry.killIntent);
      const killReconciliation = JSON.stringify(entry.killReconciliation);
      restoredQueuedFailureSettlementClaims.set(identity, claim);
      const ownsClaim = () => {
        const current = currentEntry();
        return (
          restoredQueuedFailureSettlementClaims.get(identity) === claim &&
          ownsQueuedRun(current) &&
          JSON.stringify(current.queuedLaunch) === launch &&
          JSON.stringify(current.killIntent) === killIntent &&
          JSON.stringify(current.killReconciliation) === killReconciliation
        );
      };
      const ownsSessionEffects = () => {
        const current = currentEntry();
        return (
          current !== undefined &&
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
      let sessionOwnershipChanged = false;
      let sessionDeleted = false;
      try {
        const cleanupComplete = await (async () => {
          if (!ownsCleanup()) {
            return false;
          }
          if (!expectedSessionId || !expectedLifecycleRevision) {
            sessionOwnershipChanged = true;
            return true;
          }
          const cleanupSettled = await retrySubagentCleanup(
            async () => {
              if (!ownsCleanup()) {
                return false;
              }
              const outcome = await deleteSubagentSessionForCleanup({
                callGateway: callSubagentRegistryGateway,
                gatewayBinding: { resolveGatewayContext: getEntryGatewayContextResolver(entry) },
                isCurrent: ownsCleanup,
                childSessionKey: entry.childSessionKey,
                expectedSessionId,
                expectedLifecycleRevision,
                onError: (cleanupError) => {
                  throw cleanupError;
                },
              });
              sessionDeleted = outcome === "deleted";
              sessionOwnershipChanged = outcome === "changed";
              return outcome !== "failed";
            },
            {
              shouldRetry: () => !launchTerminationConfirmed && ownsCleanup(),
              onError: (cleanupError) =>
                warn("failed to delete restored collector session after launch failure", {
                  runId,
                  childSessionKey: entry.childSessionKey,
                  error: cleanupError,
                }),
            },
          );
          if (!cleanupSettled || !ownsCleanup() || sessionOwnershipChanged) {
            return cleanupSettled && ownsCleanup();
          }
          return await cleanupCollectorLaunchResources(entry, { isCurrent: ownsCleanup });
        })().catch((cleanupError: unknown) => {
          warn("failed to clean restored collector after launch failure", {
            runId,
            childSessionKey: entry.childSessionKey,
            error: cleanupError,
          });
          return false;
        });

        if (!ownsClaim()) {
          return !ownsQueuedRun();
        }
        let failureSettled = false;
        await retrySubagentCleanup(
          async () => {
            if (!ownsClaim()) {
              return !ownsQueuedRun();
            }
            await suppressRetiredSessionEffects();
            if (!ownsClaim()) {
              return false;
            }
            failureSettled = await settleFailedQueuedSubagentLaunch(runId, error);
            return failureSettled;
          },
          {
            shouldRetry: ownsClaim,
            onError: (persistError) =>
              warn("failed to persist restored collector launch failure", {
                runId,
                childSessionKey: entry.childSessionKey,
                error: persistError,
              }),
          },
        );
        if (!failureSettled) {
          return !ownsQueuedRun();
        }
        await suppressRetiredSessionEffects();
        if (cleanupComplete && isSameSubagentRunOwner(currentEntry(), entry)) {
          if (sessionDeleted && !sessionOwnershipChanged) {
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
        if (restoredQueuedFailureSettlementClaims.get(identity) === claim) {
          restoredQueuedFailureSettlementClaims.delete(identity);
        }
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
      generation += 1;
      clearRestoreRetryTimer();
      restoreState = "idle";
      restoredRowsPending = false;
      activationRequested = false;
      activated = false;
    },
  };
}
