/**
 * Subagent run manager.
 *
 * Waits for child runs, records native terminal outcomes, and archives completed sessions.
 */
import {
  getAgentEventLifecycleGeneration,
  isAgentEventLifecycleGenerationCurrent,
} from "../../../infra/agent-events.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../../infra/sqlite-worker-contract.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { clearGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../../../process/gateway-work-admission.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import { withSubagentOutcomeTiming } from "../announce/subagent-announce-output.js";
import { updateSwarmCollectorCompletion } from "../swarm/swarm-collector.js";
import { holdQueuedSwarmRun, isSwarmRunActive } from "../swarm/swarm-scheduler.js";
import {
  persistSubagentAbortedLastRun,
  prepareSubagentKillSession,
  type SubagentKillSession,
} from "./subagent-control-session.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "./subagent-lifecycle-events.js";
import { shouldSuppressSubagentRecoverySessionEffects } from "./subagent-recovery-state.js";
import { resolveKilledSubagentTaskEndedAt } from "./subagent-registry-completion.js";
import {
  persistSubagentSessionTiming,
  safeRemoveAttachmentsDir,
  updateSubagentArchiveAtMs,
} from "./subagent-registry-helpers.js";
import {
  assertSubagentRegistryWriteOutcomeKnown,
  assertSubagentRegistryWriteSourceCurrent,
  captureSubagentRunMutationSnapshot,
  publishSubagentRunPostimages,
} from "./subagent-registry-persistence.js";
import { SubagentLaunchManager } from "./subagent-registry-run-launch.js";
import type { SubagentManagerOptions } from "./subagent-registry-run-wait.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export { preserveSubagentRunForRestart } from "./subagent-registry-run-wait.js";

const log = createSubsystemLogger("agents/subagent-registry");

class SubagentRunManager extends SubagentLaunchManager {
  readonly releaseSubagentRun = (runId: string): void => {
    const entry = this.options.runs.get(runId);
    if (!entry) {
      return;
    }
    this.options.runs.delete(runId);
    try {
      this.options.persistOrThrow(runId);
    } catch (error) {
      this.options.runs.set(runId, entry);
      throw error;
    }
    this.options.clearPendingLifecycleError(runId);
    clearGatewayContextResolver(entry);
    if (this.shouldDeleteAttachments(entry)) {
      void safeRemoveAttachmentsDir(entry);
    }
    const releasedSessionStillUnowned = () =>
      !Array.from(this.options.getRunsForChildSession(entry.childSessionKey)).some(
        (candidate) => candidate !== entry,
      );
    void this.options.notifyContextEngineSubagentEnded(
      {
        childSessionKey: entry.childSessionKey,
        reason: "released",
        agentDir: entry.agentDir,
        workspaceDir: entry.workspaceDir,
      },
      { isCurrent: releasedSessionStillUnowned },
    );
    if (this.options.runs.size === 0) {
      this.options.stopSweeper();
    }
  };

  readonly claimSubagentRunKill = async (claimParams: {
    runId: string;
    expected: SubagentRunRecord;
    sessionId?: string;
    sessionLifecycleRevision?: string;
    suppressTaskDelivery?: boolean;
    assertCurrent?: () => void;
    assertPublicationCurrent?: () => void;
    context?: OpenClawStateWorkerContext;
  }): Promise<SubagentRunRecord["killIntent"]> => {
    const runId = claimParams.runId.trim();
    const entry = this.options.runs.get(runId);
    if (
      !runId ||
      entry !== claimParams.expected ||
      entry.killReconciliation !== undefined ||
      entry.killIntent !== undefined ||
      (typeof entry.execution.endedAt === "number" && entry.pauseReason !== "sessions_yield")
    ) {
      return undefined;
    }
    const claim = {
      requestedAt: Date.now(),
      reason: "killed",
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
      sessionId: claimParams.sessionId?.trim() || undefined,
      sessionLifecycleRevision: claimParams.sessionLifecycleRevision?.trim() || undefined,
      suppressTaskDelivery: claimParams.suppressTaskDelivery === true ? true : undefined,
    };
    const context = claimParams.context ?? captureOpenClawStateWorkerContext();
    const previous = captureSubagentRunMutationSnapshot(entry);
    entry.killIntent = claim;
    const assertClaimCurrent = (publication = false) => {
      (publication
        ? (claimParams.assertPublicationCurrent ?? claimParams.assertCurrent)
        : claimParams.assertCurrent)?.();
      if (!isAgentEventLifecycleGenerationCurrent(claim.lifecycleGeneration)) {
        throw new Error("Subagent kill lifecycle changed");
      }
    };
    const result = await publishSubagentRunPostimages({
      runs: this.options.runs,
      previous: new Map([[entry, previous]]),
      pendingKillClaim: entry,
      persist: this.options.persistAsyncOrThrow,
      context,
      assertCurrent: () => assertClaimCurrent(),
      assertPublicationCurrent: () => assertClaimCurrent(true),
    });
    return result.publication === "published" ? claim : undefined;
  };

  readonly releaseSubagentRunKillClaim = async (releaseParams: {
    runId: string;
    expected: SubagentRunRecord;
    claim: NonNullable<SubagentRunRecord["killIntent"]>;
    assertCurrent?: () => void;
    context?: OpenClawStateWorkerContext;
  }): Promise<boolean> => {
    const runId = releaseParams.runId.trim();
    const entry = this.options.runs.get(runId);
    if (!runId || entry !== releaseParams.expected || entry.killIntent !== releaseParams.claim) {
      return false;
    }
    const context = releaseParams.context ?? captureOpenClawStateWorkerContext();
    const previous = captureSubagentRunMutationSnapshot(entry);
    entry.killIntent = undefined;
    const result = await publishSubagentRunPostimages({
      runs: this.options.runs,
      previous: new Map([[entry, previous]]),
      persist: this.options.persistAsyncOrThrow,
      context,
      assertCurrent: () => releaseParams.assertCurrent?.(),
    });
    return result.publication === "published";
  };

  readonly markSubagentRunTerminated = async (markParams: {
    runId?: string;
    childSessionKey?: string;
    reason?: string;
    suppressTaskDelivery?: boolean;
    session?: SubagentKillSession;
    withdrawQueuedReservation?: () => void;
    assertCurrent?: () => void;
    assertPublicationCurrent?: () => void;
    /** Retain the committed count while cleanup continues under current authority. */
    onPublished?: (count: number) => void;
    context?: OpenClawStateWorkerContext;
  }): Promise<number> => {
    const runIds = new Set<string>();
    if (typeof markParams.runId === "string" && markParams.runId.trim()) {
      runIds.add(markParams.runId.trim());
    }
    const childSessionKey = markParams.childSessionKey?.trim();
    if (childSessionKey) {
      for (const entry of this.options.getRunsForChildSession(childSessionKey)) {
        runIds.add(entry.runId);
      }
    }
    if (runIds.size === 0) {
      return 0;
    }

    const context = markParams.context ?? captureOpenClawStateWorkerContext();
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const selected = new Map(
      [...runIds].flatMap((id) => {
        const entry = this.options.runs.get(id);
        return entry ? [[id, entry] as const] : [];
      }),
    );
    let published = false;
    const assertSelectedCurrent = (requireSession = true) => {
      assertSubagentRegistryWriteSourceCurrent(context);
      assertSubagentRegistryWriteOutcomeKnown([...runIds], context.admission);
      if (requireSession) {
        markParams.session?.assertCurrent();
      }
      if (
        !isAgentEventLifecycleGenerationCurrent(lifecycleGeneration) ||
        [...selected].some(([id, entry]) => this.options.runs.get(id) !== entry)
      ) {
        throw new Error("Subagent termination lost its selected registry owner");
      }
    };
    const assertCurrent = (publication = false) => {
      assertSelectedCurrent();
      (publication || published
        ? (markParams.assertPublicationCurrent ?? markParams.assertCurrent)
        : markParams.assertCurrent)?.();
    };
    assertCurrent();
    const terminalReleases: Array<() => void> = [];
    const releaseTerminalState = () => {
      for (const release of terminalReleases.splice(0).toReversed()) {
        release();
      }
    };
    const sessions = new Map<string, SubagentKillSession>();
    const holds = new Map<string, NonNullable<ReturnType<typeof holdQueuedSwarmRun>>>();
    for (const entry of selected.values()) {
      if (
        entry.collect &&
        entry.execution.status === "queued" &&
        !(markParams.runId === entry.runId && markParams.withdrawQueuedReservation)
      ) {
        const hold = holdQueuedSwarmRun(entry.schedulerSlotId ?? entry.runId);
        if (hold) {
          holds.set(entry.runId, hold);
        }
      }
    }
    try {
      // Completion capture and Stop write the same canonical row. Use its existing
      // state/capture owner, with a stable order for multi-run termination.
      for (const runId of [...selected.keys()].toSorted()) {
        terminalReleases.push(await this.options.acquireTerminalCompletionLock(runId));
        assertSelectedCurrent(false);
      }
      for (const entry of selected.values()) {
        if (markParams.runId === entry.runId && markParams.session) {
          sessions.set(entry.runId, markParams.session);
        } else if (entry.collect && entry.execution.status === "queued") {
          const session = await prepareSubagentKillSession(
            this.options.getRuntimeConfig(),
            entry.childSessionKey,
            assertCurrent,
          );
          sessions.set(entry.runId, session);
        }
      }
      const now = Date.now();
      const reason = markParams.reason?.trim() || "killed";
      let updated = 0;
      const entriesByChildSessionKey = new Map<string, SubagentRunRecord>();
      const queuedCollectorRunIds: string[] = [];
      const entrySnapshots = new Map<SubagentRunRecord, SubagentRunRecord>();
      const publishTermination = async () => {
        assertSelectedCurrent();
        for (const runId of runIds) {
          this.options.clearPendingLifecycleError(runId);
          this.options.clearPendingLifecycleTimeout(runId);
          const entry = this.options.runs.get(runId);
          if (!entry) {
            continue;
          }
          const wasKilledLifecycle =
            entry.endedReason === SUBAGENT_ENDED_REASON_KILLED &&
            entry.killReconciliation !== undefined;
          const existingKillReconciliation = entry.killReconciliation;
          const existingKillIntent = entry.killIntent;
          const currentKillLifecycle =
            existingKillIntent?.lifecycleGeneration !== undefined &&
            isAgentEventLifecycleGenerationCurrent(existingKillIntent.lifecycleGeneration);
          if (
            typeof entry.execution.endedAt === "number" &&
            entry.pauseReason !== "sessions_yield" &&
            !wasKilledLifecycle
          ) {
            // An abort lifecycle event can mark the run killed before this shared
            // termination path runs. Re-enter only for that provisional state so
            // it receives the same reconciliation tombstone as a direct kill.
            continue;
          }
          assertCurrent();
          // Rollback must retain the exact claim owned by the pending cancellation.
          entrySnapshots.set(entry, captureSubagentRunMutationSnapshot(entry));
          const wasYielded = entry.pauseReason === "sessions_yield";
          const wasQueuedCollector = entry.collect && entry.execution.status === "queued";
          const collectorLaunchInFlight =
            wasQueuedCollector &&
            entry.swarmLaunchPending === true &&
            isSwarmRunActive(entry.schedulerSlotId ?? entry.runId);
          if (wasQueuedCollector) {
            queuedCollectorRunIds.push(entry.runId);
          }
          const endedAt =
            (wasYielded || wasKilledLifecycle) && typeof entry.execution.endedAt === "number"
              ? entry.execution.endedAt
              : now;
          entry.execution = {
            ...entry.execution,
            status: "terminal",
            endedAt,
            lifecycleGeneration:
              existingKillIntent && currentKillLifecycle
                ? existingKillIntent.lifecycleGeneration
                : entry.execution.lifecycleGeneration,
            restartRecovery: undefined,
            suppressSessionEffects:
              existingKillIntent && currentKillLifecycle
                ? undefined
                : entry.execution.suppressSessionEffects,
            outcome: withSubagentOutcomeTiming(
              { status: "error", error: reason },
              {
                startedAt: entry.execution.startedAt,
                endedAt,
              },
            ),
          };
          entry.endedReason = SUBAGENT_ENDED_REASON_KILLED;
          entry.cleanupHandled = true;
          entry.cleanupCompletedAt = existingKillReconciliation
            ? (entry.cleanupCompletedAt ?? endedAt)
            : wasKilledLifecycle
              ? endedAt
              : now;
          entry.suppressAnnounceReason = "killed";
          entry.pauseReason = undefined;
          entry.killIntent = undefined;
          const taskEndedAt = existingKillIntent
            ? existingKillIntent.requestedAt
            : existingKillReconciliation
              ? (resolveKilledSubagentTaskEndedAt(entry) ?? endedAt)
              : wasYielded
                ? now
                : endedAt;
          entry.killReconciliation = {
            killedAt:
              existingKillIntent?.requestedAt ??
              existingKillReconciliation?.killedAt ??
              taskEndedAt,
            taskCancellationAccepted:
              existingKillIntent || existingKillReconciliation?.taskCancellationAccepted === true
                ? true
                : undefined,
            suppressTaskDelivery:
              existingKillIntent?.suppressTaskDelivery === true ||
              existingKillReconciliation?.suppressTaskDelivery === true ||
              markParams.suppressTaskDelivery === true
                ? true
                : undefined,
            supersededAt: existingKillReconciliation?.supersededAt,
          };
          if (wasQueuedCollector && !collectorLaunchInFlight) {
            const session = sessions.get(entry.runId);
            session?.assertCurrent();
            updateSwarmCollectorCompletion(entry, this.options.getRuntimeConfig(), {
              entry: session?.entry,
            });
          } else if (!entry.collect) {
            updateSubagentArchiveAtMs(entry, this.options.getRuntimeConfig());
          }
          if (!entriesByChildSessionKey.has(entry.childSessionKey)) {
            entriesByChildSessionKey.set(entry.childSessionKey, entry);
          }
          updated += 1;
        }
        if (updated > 0) {
          const result = await publishSubagentRunPostimages({
            runs: this.options.runs,
            previous: entrySnapshots,
            persist: this.options.persistAsyncOrThrow,
            context,
            assertCurrent,
            assertPublicationCurrent: () => assertCurrent(true),
            onPublished: () => {
              published = true;
              markParams.onPublished?.(updated);
            },
          });
          return result.publication === "published";
        }
        return false;
      };
      const committed = markParams.session
        ? await markParams.session.withPublication(publishTermination)
        : await publishTermination();
      if (!committed) {
        return 0;
      }
      releaseTerminalState();
      for (const runId of queuedCollectorRunIds) {
        assertCurrent();
        if (markParams.runId === runId && markParams.withdrawQueuedReservation) {
          markParams.withdrawQueuedReservation();
        } else {
          holds.get(runId)?.withdraw();
        }
      }
      for (const entry of entriesByChildSessionKey.values()) {
        const reconciliation = entry.killReconciliation;
        await runWithGatewayIndependentRootWorkAdmission(async () => {
          await Promise.all([
            persistSubagentSessionTiming(entry, {
              session: sessions.get(entry.runId),
              isCurrentGeneration: () =>
                this.currentRunOwnsSession(entry) &&
                !shouldSuppressSubagentRecoverySessionEffects(entry),
              assertCommitAllowed: () => {
                assertCurrent();
                if (
                  !this.currentRunOwnsSession(entry) ||
                  shouldSuppressSubagentRecoverySessionEffects(entry)
                ) {
                  throw new Error("killed subagent session owner retired before timing commit");
                }
              },
            }).catch((err: unknown) => {
              if (hasSqliteWorkerOutcomeUnknown(err)) {
                throw err;
              }
              log.warn("failed to persist killed subagent session timing", {
                err,
                runId: entry.runId,
                childSessionKey: entry.childSessionKey,
              });
            }),
            this.shouldDeleteAttachments(entry)
              ? safeRemoveAttachmentsDir(entry)
              : Promise.resolve(),
          ]);
        }, "subagents:session-finalize").catch((err: unknown) => {
          if (hasSqliteWorkerOutcomeUnknown(err)) {
            throw err;
          }
          log.warn("failed to run killed subagent cleanup tail", {
            err,
            runId: entry.runId,
            childSessionKey: entry.childSessionKey,
          });
        });
        await this.options.completeCleanupBookkeeping({
          runId: entry.runId,
          entry,
          // A direct kill is provisional until the runner reports its final
          // outcome. Keep delete-mode rows as reconciliation tombstones.
          cleanup: "keep",
          completedAt: now,
          preserveTranscript: true,
          provisionalKill: true,
          stateContext: context,
          isCurrent: () => {
            assertCurrent();
            return this.currentRunOwnsSession(entry);
          },
        });
        const session = markParams.runId === entry.runId ? markParams.session : undefined;
        if (session) {
          const ownsOriginalKill = () =>
            this.currentRunOwnsSession(entry) &&
            !shouldSuppressSubagentRecoverySessionEffects(entry) &&
            entry.endedReason === SUBAGENT_ENDED_REASON_KILLED &&
            entry.suppressAnnounceReason !== "steer-restart" &&
            reconciliation !== undefined &&
            entry.killReconciliation === reconciliation;
          // Join metadata publication before checking retained generation facts.
          // The same row can receive an earlier completion while cleanup yields.
          await persistSubagentAbortedLastRun({
            childSessionKey: entry.childSessionKey,
            storePath: session.storePath,
            hasSessionEntry: session.entry !== undefined,
            expectedSessionId: session.entry?.sessionId,
            expectedLifecycleRevision: session.entry?.lifecycleRevision,
            abortedLastRun: true,
            isCurrent: ownsOriginalKill,
            assertCommitAllowed: () => {
              assertCurrent();
              if (!ownsOriginalKill()) {
                throw new Error("subagent kill lifecycle retired before abort-marker commit");
              }
            },
          });
        }
      }
      return updated;
    } finally {
      releaseTerminalState();
      for (const session of sessions.values()) {
        if (session !== markParams.session) {
          await session.release();
        }
      }
      await Promise.all([...holds.values()].map((hold) => hold.release()));
    }
  };
}

export function createSubagentRunManager(params: SubagentManagerOptions) {
  return new SubagentRunManager(params);
}
