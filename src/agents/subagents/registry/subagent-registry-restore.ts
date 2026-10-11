import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { getRuntimeConfig } from "../../../config/config.js";
import { ADMIN_SCOPE } from "../../../gateway/method-scopes.js";
import type { GatewayContextResolver } from "../../../gateway/server-methods/types.js";
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
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import { resolveSubagentRequesterAgentId } from "../../subagent-requester-owner.js";
import { applySubagentLaunchAuthorization } from "../spawn/subagent-launch-authorization.js";
import { readGatewayRunId } from "../spawn/subagent-spawn-gateway.js";
import { resolveSwarmConfig } from "../swarm/swarm-config.js";
import { bindSwarmRunReservation, enqueueSwarmRun } from "../swarm/swarm-scheduler.js";
import { shouldSuppressSubagentRecoverySessionEffects } from "./subagent-recovery-state.js";
import { callSubagentRegistryGateway } from "./subagent-registry-deps.js";
import { updateSubagentArchiveAtMs } from "./subagent-registry-helpers.js";
import type { SubagentLifecycleOptions } from "./subagent-registry-lifecycle-context.js";
import type { SubagentLifecycleController } from "./subagent-registry-lifecycle.js";
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
import { settleRestoredRequesterTurns } from "./subagent-registry-restore-requester.js";
import type { SubagentLaunchManager } from "./subagent-registry-run-launch.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { getSubagentRunRuntimeKey, isSameSubagentRunOwner } from "./subagent-run-generation.js";
import { deleteSubagentSessionForCleanup } from "./subagent-session-cleanup.js";
import { loadSubagentSessionEntry } from "./subagent-session-reconciliation.js";

const restoredQueuedFailureSettlementClaims = new WeakSet<object>();

export function isRestoredQueuedFailureSettlementClaimed(entry: SubagentRunRecord): boolean {
  return restoredQueuedFailureSettlementClaims.has(getSubagentRunRuntimeKey(entry));
}

export function createSubagentRegistryRestorer(config: {
  runs: Map<string, SubagentRunRecord>;
  getGatewayContextResolver: () => GatewayContextResolver | undefined;
  bindGatewayOwners: () => boolean | Promise<boolean>;
  settleRequesterTurn: SubagentLifecycleController["settleRequesterTurnAfterSessionSpawns"];
  retireSupersededRun: SubagentLifecycleOptions["retireSupersededRun"];
  ensureListener: () => void;
  startSweeper: () => void;
  scheduleSweep: () => void;
  recoverInterruptedRuns: () => Promise<void>;
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
  // A repeated activation must not enqueue the same restored collectors again.
  let runsResumed = false;
  let restoreInFlight: Promise<void> | undefined;
  let activationInFlight: Promise<void> | undefined;
  // A later explicit restore must reconcile rows merged before an earlier failure.
  let restoredRowsPending = false;

  async function completeRestore() {
    restoredRowsPending = false;
    restoreState = "succeeded";
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
    if (restoreState !== "succeeded" || !(await bindGatewayOwners())) {
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
      if (getGatewayContextResolver() !== resolver || !gateway || resolver?.() !== gateway) {
        throw new Error("Restored requester transfer lost its Gateway owner");
      }
    };
    const cfg = getRuntimeConfig();
    const activationFailures = await settleRestoredRequesterTurns({
      cfg,
      runs,
      stateContext,
      assertCurrent,
      settleRequesterTurn,
      retireSupersededRun: config.retireSupersededRun,
    });
    assertCurrent();
    if (!runsResumed) {
      await resumeRestoredRuns(cfg, assertCurrent);
      assertCurrent();
      await config.recoverInterruptedRuns();
      assertCurrent();
      runsResumed = true;
    }
    if (activationFailures.length > 0) {
      throw activationFailures[0];
    }
    activated = true;
  }

  async function resumeRestoredRuns(
    cfg: ReturnType<typeof getRuntimeConfig>,
    assertCurrent: () => void,
  ) {
    if (runs.size === 0) {
      return;
    }
    ensureListener();
    // Session-mode runs have no archive deadline but still need TTL cleanup.
    startSweeper();
    // Resume only this captured owner set; registration may change the live map while we yield.
    const capturedRuns = [...runs];
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const assertReadCurrent = () => {
      assertCurrent();
      if (!isAgentEventLifecycleGenerationCurrent(lifecycleGeneration)) {
        throw new Error("Restored subagent read lost its Gateway lifecycle");
      }
    };
    let visited = 0;
    for (const [runId, snapshot] of capturedRuns) {
      if (++visited % 128 === 0) {
        await yieldToEventLoop();
        assertCurrent();
      }
      const selected = getCurrentSubagentRunOwner(runs, snapshot);
      if (!selected || selected.runId !== runId) {
        continue;
      }
      assertReadCurrent();
      // Terminal delivery has its own session checks; startup only reconciles unfinished runs.
      const sessionEntry =
        typeof selected.execution.endedAt === "number"
          ? undefined
          : await loadSubagentSessionEntry({
              childSessionKey: selected.childSessionKey,
              childAgentId: selected.childAgentId,
              assertCurrent: assertReadCurrent,
            });
      assertReadCurrent();
      const entry = getCurrentSubagentRunOwner(runs, snapshot);
      if (!entry || entry.runId !== runId) {
        continue;
      }
      // Restart recovery and accepted cancellation own their rows independently.
      if (entry.execution.restartRecovery || entry.killIntent || entry.killReconciliation) {
        continue;
      }
      if (entry.collect && entry.execution.status === "queued") {
        const launch = entry.queuedLaunch;
        if (!launch) {
          void failAndCleanupRestoredQueuedRun(
            entry,
            "queued collector launch state was unavailable after restart",
            getAgentEventLifecycleGeneration(),
            sessionEntry?.sessionId,
            sessionEntry?.lifecycleRevision,
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
          maxConcurrent: resolveSwarmConfig(cfg, entry.requesterAgentId).maxConcurrent,
          activeRunIds: listSwarmRunsForGroup(groupId, requesterSessionKey, entry.requesterAgentId)
            .filter(
              (candidate) =>
                candidate.execution.status === "running" ||
                candidate.execution.status === "interrupted",
            )
            .map((candidate) => candidate.schedulerSlotId ?? candidate.runId),
          start: async () => {
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
              const request = applySubagentLaunchAuthorization(
                launch.request,
                launch.authorization,
              );
              const gatewayRuntime = getGatewayContextResolver()?.()?.recoveryRuntime;
              if (!gatewayRuntime) {
                throw new GatewayDrainingError();
              }
              const response = await gatewayRuntime.dispatchAgent(
                request as Parameters<typeof gatewayRuntime.dispatchAgent>[0],
                launch.timeoutMs,
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
                expectedSessionId: sessionEntry?.sessionId,
                expectedLifecycleRevision: sessionEntry?.lifecycleRevision,
              });
            }
            return failAndCleanupRestoredQueuedRun(
              entry,
              error instanceof Error ? error.message : String(error),
              launchLifecycleGeneration ?? getAgentEventLifecycleGeneration(),
              sessionEntry?.sessionId,
              sessionEntry?.lifecycleRevision,
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
          const cfg = getRuntimeConfig();
          await mutateSubagentRuns(
            [...runs.keys()],
            (rows) => {
              const postimages = new Map<string, SubagentRunRecord>();
              for (const [runId, entry] of rows) {
                const draft = { ...entry };
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
        }
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
            childAgentId: entry.childAgentId,
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
    activate: () => activateRestoredRuns(),
    // Old sweepers and reopened admission must wait for restored inventory and its Gateway.
    canResumeWakes: () =>
      !activationRequested ||
      (restoreState === "succeeded" && Boolean(getGatewayContextResolver()?.())),
    reset: () => {
      restoreState = "idle";
      restoredRowsPending = false;
      activationRequested = false;
      activated = false;
      runsResumed = false;
    },
  };
}
