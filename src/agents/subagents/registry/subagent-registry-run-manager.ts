import {
  getAgentEventLifecycleGeneration,
  isAgentEventLifecycleGenerationCurrent,
} from "../../../infra/agent-events.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../../infra/sqlite-worker-contract.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../../../process/gateway-work-admission.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import { withSubagentOutcomeTiming } from "../announce/subagent-announce-output.js";
import {
  clearPublishedSwarmCollectorOutput,
  updateSwarmCollectorCompletion,
} from "../swarm/swarm-collector.js";
import { holdQueuedSwarmRun, isSwarmRunActive } from "../swarm/swarm-scheduler.js";
import {
  persistSubagentAbortedLastRun,
  prepareSubagentKillSession,
  type SubagentKillSession,
} from "./subagent-control-session.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "./subagent-lifecycle-events.js";
import { shouldSuppressSubagentRecoverySessionEffects } from "./subagent-recovery-state.js";
import { resolveKilledSubagentTaskEndedAt } from "./subagent-registry-completion.js";
import { retireSubagentGatewayBinding } from "./subagent-registry-execution-cleanup.js";
import {
  persistSubagentSessionTiming,
  safeRemoveAttachmentsDir,
  shouldRemoveSubagentAttachments,
  updateSubagentArchiveAtMs,
} from "./subagent-registry-helpers.js";
import {
  assertSubagentRegistryWriteOutcomeKnown,
  assertSubagentRegistryWriteSourceCurrent,
  mutateSubagentRuns,
} from "./subagent-registry-persistence.js";
import { SubagentLaunchManager } from "./subagent-registry-run-launch.js";
import type { SubagentManagerOptions } from "./subagent-registry-run-wait.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { isSameSubagentRunOwner } from "./subagent-run-generation.js";

export { preserveSubagentRunForRestart } from "./subagent-registry-run-wait.js";

const log = createSubsystemLogger("agents/subagent-registry");

class SubagentRunManager extends SubagentLaunchManager {
  readonly releaseSubagentRun = async (runId: string): Promise<void> => {
    const selected = this.options.runs.get(runId);
    if (!selected) {
      return;
    }
    const entry = await mutateSubagentRuns(
      [runId],
      (rows) => {
        const current = rows.get(runId);
        return current && isSameSubagentRunOwner(current, selected)
          ? { value: current, postimages: new Map([[runId, null]]) }
          : { value: undefined };
      },
      { runs: this.options.runs },
    );
    if (!entry) {
      return;
    }
    this.options.clearPendingLifecycleError(runId);
    retireSubagentGatewayBinding(entry);
    if (shouldRemoveSubagentAttachments(entry)) {
      void safeRemoveAttachmentsDir(entry);
    }
    const releasedSessionStillUnowned = () =>
      !Array.from(
        this.options.getRunsForChildSession(entry.childSessionKey, entry.childAgentId),
      ).some((candidate) => !isSameSubagentRunOwner(candidate, entry));
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
    const claim = {
      requestedAt: Date.now(),
      reason: "killed",
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
      sessionId: claimParams.sessionId?.trim() || undefined,
      sessionLifecycleRevision: claimParams.sessionLifecycleRevision?.trim() || undefined,
      suppressTaskDelivery: claimParams.suppressTaskDelivery === true ? true : undefined,
    };
    const context = claimParams.context ?? captureOpenClawStateWorkerContext();
    const assertClaimCurrent = () => {
      claimParams.assertCurrent?.();
      if (!isAgentEventLifecycleGenerationCurrent(claim.lifecycleGeneration)) {
        throw new Error("Subagent kill lifecycle changed");
      }
    };
    return mutateSubagentRuns(
      [runId],
      (rows) => {
        const entry = rows.get(runId);
        if (
          !runId ||
          !entry ||
          !isSameSubagentRunOwner(entry, claimParams.expected) ||
          entry.killReconciliation ||
          entry.killIntent ||
          (typeof entry.execution.endedAt === "number" && entry.pauseReason !== "sessions_yield")
        ) {
          return { value: undefined };
        }
        return { value: claim, postimages: new Map([[runId, { ...entry, killIntent: claim }]]) };
      },
      {
        runs: this.options.runs,
        context,
        pendingKillClaim: claimParams.expected,
        assertCurrent: () => assertClaimCurrent(),
      },
    );
  };

  readonly releaseSubagentRunKillClaim = async (releaseParams: {
    runId: string;
    expected: SubagentRunRecord;
    claim: NonNullable<SubagentRunRecord["killIntent"]>;
    assertCurrent?: () => void;
    context?: OpenClawStateWorkerContext;
  }): Promise<boolean> => {
    const runId = releaseParams.runId.trim();
    return mutateSubagentRuns(
      [runId],
      (rows) => {
        const entry = rows.get(runId);
        const claim = entry?.killIntent;
        const expectedClaim = releaseParams.claim;
        if (
          !runId ||
          !entry ||
          !isSameSubagentRunOwner(entry, releaseParams.expected) ||
          !claim ||
          claim.requestedAt !== expectedClaim.requestedAt ||
          claim.reason !== expectedClaim.reason ||
          claim.lifecycleGeneration !== expectedClaim.lifecycleGeneration ||
          claim.sessionId !== expectedClaim.sessionId ||
          claim.sessionLifecycleRevision !== expectedClaim.sessionLifecycleRevision ||
          claim.suppressTaskDelivery !== expectedClaim.suppressTaskDelivery
        ) {
          return { value: false };
        }
        return { value: true, postimages: new Map([[runId, { ...entry, killIntent: undefined }]]) };
      },
      {
        runs: this.options.runs,
        context: releaseParams.context,
        assertCurrent: releaseParams.assertCurrent,
      },
    );
  };

  readonly markSubagentRunTerminated = async (markParams: {
    runId?: string;
    childSessionKey?: string;
    childAgentId?: string;
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
      for (const entry of this.options.getRunsForChildSession(
        childSessionKey,
        markParams.childAgentId ?? markParams.session?.agentId,
      )) {
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
        [...selected].some(
          ([id, entry]) => !isSameSubagentRunOwner(this.options.runs.get(id), entry),
        )
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
            entry.execution.transcriptTarget,
            entry.childAgentId,
          );
          sessions.set(entry.runId, session);
        }
      }
      const now = Date.now();
      const reason = markParams.reason?.trim() || "killed";
      let updated = 0;
      const entriesByChildSessionKey = new Map<string, SubagentRunRecord>();
      const queuedCollectorRunIds: string[] = [];
      const publishTermination = () =>
        mutateSubagentRuns(
          [...runIds],
          (rows) => {
            assertSelectedCurrent();
            updated = 0;
            entriesByChildSessionKey.clear();
            queuedCollectorRunIds.length = 0;
            const postimages = new Map<string, SubagentRunRecord | null>();
            for (const runId of runIds) {
              const current = rows.get(runId);
              if (!current) {
                continue;
              }
              const entry = structuredClone(current);
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
                  existingKillIntent ||
                  existingKillReconciliation?.taskCancellationAccepted === true
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
              postimages.set(runId, entry);
              updated += 1;
            }
            return { value: updated > 0, postimages };
          },
          {
            runs: this.options.runs,
            context,
            assertCurrent,
            onPublished: (postimages) => {
              for (const [runId, entry] of postimages) {
                if (entry) {
                  clearPublishedSwarmCollectorOutput(entry);
                }
                this.options.clearPendingLifecycleError(runId);
                this.options.clearPendingLifecycleTimeout(runId);
              }
              published = true;
              markParams.onPublished?.(updated);
            },
          },
        );
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
                !shouldSuppressSubagentRecoverySessionEffects(
                  this.options.runs.get(entry.runId) ?? entry,
                ),
              assertCommitAllowed: () => {
                assertCurrent();
                if (
                  !this.currentRunOwnsSession(entry) ||
                  shouldSuppressSubagentRecoverySessionEffects(
                    this.options.runs.get(entry.runId) ?? entry,
                  )
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
            shouldRemoveSubagentAttachments(entry)
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
            !shouldSuppressSubagentRecoverySessionEffects(
              this.options.runs.get(entry.runId) ?? entry,
            ) &&
            this.options.runs.get(entry.runId)?.endedReason === SUBAGENT_ENDED_REASON_KILLED &&
            this.options.runs.get(entry.runId)?.suppressAnnounceReason !== "steer-restart" &&
            reconciliation !== undefined &&
            this.options.runs.get(entry.runId)?.killReconciliation?.killedAt ===
              reconciliation.killedAt &&
            this.options.runs.get(entry.runId)?.killReconciliation?.supersededAt ===
              reconciliation.supersededAt;
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
