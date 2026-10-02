import type { GatewayContextResolver } from "../../../gateway/server-methods/types.js";
import { captureOperatorToolGatewayContinuationContext } from "../../../gateway/server-plugin-in-process-dispatch.js";
import {
  getAgentEventLifecycleGeneration,
  isAgentEventLifecycleGenerationCurrent,
} from "../../../infra/agent-events.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import {
  bindGatewayContextResolver,
  getGatewayContextResolver,
} from "../../../plugins/runtime/gateway-request-scope.js";
import { runWithGatewayDetachedWorkContinuation } from "../../../process/gateway-work-admission.js";
import { removeInternalSessionEffectsSession } from "../../internal-session-effects.js";
import type { AgentRunSessionTarget } from "../../run-session-target.types.js";
import { replaceRequesterCronAuthorityEntry } from "../requester-cron-authority.js";
import { matchesSubagentChildSessionOwner } from "./subagent-child-owner-match.js";
import {
  clearDeliveryState,
  normalizeSubagentRunState,
  resetRequesterSettleWakeRetry,
} from "./subagent-delivery-state.js";
import { safeRemoveAttachmentsDir } from "./subagent-registry-helpers.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import {
  mutateSubagentRuns,
  SubagentRegistryMutationRejectedError,
} from "./subagent-registry-persistence.js";
import { getLatestSubagentRunByChildSessionKeyFromRuns } from "./subagent-registry-queries.js";
import { SubagentWaitManager } from "./subagent-registry-run-wait.js";
import type { RequesterSettleWakeState, SubagentRunRecord } from "./subagent-registry.types.js";
import {
  compareSubagentRunGeneration,
  getSubagentRunRuntimeKey,
  isSameSubagentRunOwner,
  nextSubagentRunGeneration,
} from "./subagent-run-generation.js";
import {
  getSubagentSessionRuntimeMs,
  getSubagentSessionStartedAt,
} from "./subagent-session-metrics.js";

const log = createSubsystemLogger("agents/subagent-registry");

export class SubagentRecoveryManager extends SubagentWaitManager {
  protected planSupersededKillReconciliations(
    rows: ReadonlyMap<string, SubagentRunRecord>,
    next: SubagentRunRecord,
  ): Map<string, SubagentRunRecord | null> {
    const postimages = new Map<string, SubagentRunRecord | null>();
    for (const current of rows.values()) {
      if (
        !matchesSubagentChildSessionOwner(current, next.childSessionKey, next.childAgentId) ||
        current.runId === next.runId ||
        compareSubagentRunGeneration(current, next) >= 0 ||
        !current.killReconciliation
      ) {
        continue;
      }
      postimages.set(current.runId, {
        ...current,
        killReconciliation: {
          ...current.killReconciliation,
          supersededAt: Math.min(
            current.killReconciliation.supersededAt ?? next.createdAt,
            next.createdAt,
          ),
        },
      });
    }
    return postimages;
  }

  /**
   * Continues a `sessions_yield`-paused run under a new gateway runId.
   *
   * A follow-up dispatched to a paused child session is the same unit of work as
   * the run that yielded, so it must adopt that row instead of minting a sibling.
   * Registering a new row would move the requester to the child's own main session
   * and strand the original requester's paused row as merely superseded: its
   * announce stays gated on `pauseReason`, and its settle batch keeps deferring
   * because the row still counts as an unsettled descendant. Returns false when no
   * paused row owns the session, leaving ordinary registration to the caller.
   */
  readonly adoptPausedSubagentRunForFollowUp = async (params: {
    childSessionKey: string;
    childAgentId?: string;
    runId: string;
    task: string;
    /** Exact paused owner captured by explicit task-resume admission. */
    expected?: SubagentRunRecord;
    gatewayContextResolver?: GatewayContextResolver;
    assertCurrent?: () => void;
    onPublished?: (entry: SubagentRunRecord) => void;
  }): Promise<boolean> => {
    const childSessionKey = params.childSessionKey.trim();
    const runId = params.runId.trim();
    if (!childSessionKey || !runId) {
      return false;
    }
    const childAgentId = params.childAgentId ?? params.expected?.childAgentId;
    // Select the newest paused row rather than the newest row overall: a
    // requester-bound follow-up stays a sibling at a higher generation, and
    // matching on generation alone would let that sibling hide the paused owner
    // and park its requester for good.
    const paused = getLatestSubagentRunByChildSessionKeyFromRuns(
      this.options.getRunsForChildSession(childSessionKey, childAgentId),
      childSessionKey,
      (entry) => entry.pauseReason === "sessions_yield",
      childAgentId,
    );
    if (!paused || (params.expected && !isSameSubagentRunOwner(paused, params.expected))) {
      return false;
    }
    return this.replaceSubagentRunAfterSteer({
      assertCurrent: params.assertCurrent,
      onPublished: params.onPublished,
      previousRunId: paused.runId,
      nextRunId: runId,
      expected: paused,
      // A paused row is terminal by construction; adoption is exactly the case the
      // ended-source gate exists to keep out of unrelated replacement callers.
      allowEndedSource: true,
      // The original requester is idle behind its own yield, so its wake credential
      // is the only path back to it once this follow-up settles.
      preserveRequesterSettleWake: true,
      // Gateway admission has not started provider work yet. If this owner swap
      // is not durable, reject the dispatch instead of registering a sibling or
      // leaving a live successor that restart recovery cannot identify.
      // Persist the follow-up text so restart recovery cannot reissue the task that
      // the child already yielded on.
      task: params.task,
      ...(params.gatewayContextResolver
        ? { gatewayContextResolver: params.gatewayContextResolver }
        : {}),
    });
  };

  readonly replaceSubagentRunAfterSteer = async (replaceParams: {
    previousRunId: string;
    nextRunId: string;
    expected?: SubagentRunRecord;
    runTimeoutSeconds?: number;
    allowEndedSource?: boolean;
    /** Ordinary next turns retain the completed execution's independent delivery. */
    preserveCompletedRun?: boolean;
    preserveFrozenResultFallback?: boolean;
    // A follow-up that continues a paused run inherits the original requester's
    // wake credential. An operator steer intentionally drops it: the operator is
    // already the live audience, so re-arming would wake a requester that is no
    // longer waiting. Without this the yielded parent loses its only wake path
    // and its settle batch defers with nothing recording why.
    preserveRequesterSettleWake?: boolean;
    transcriptTarget?: AgentRunSessionTarget;
    task?: string;
    lifecycleGeneration?: string;
    gatewayContextResolver?: GatewayContextResolver;
    assertCurrent?: () => void;
    onPublished?: (entry: SubagentRunRecord) => void;
  }): Promise<boolean> => {
    const previousRunId = replaceParams.previousRunId.trim();
    const nextRunId = replaceParams.nextRunId.trim();
    if (!previousRunId || !nextRunId) {
      return false;
    }
    const lifecycleGeneration =
      replaceParams.lifecycleGeneration ?? getAgentEventLifecycleGeneration();
    if (!isAgentEventLifecycleGenerationCurrent(lifecycleGeneration)) {
      return false;
    }
    const assertCurrent = () => {
      replaceParams.assertCurrent?.();
      if (!isAgentEventLifecycleGenerationCurrent(lifecycleGeneration)) {
        throw new SubagentRegistryMutationRejectedError(
          "Subagent replacement lifecycle changed before commit",
        );
      }
    };
    const selected = this.options.runs.get(previousRunId);
    if (!selected) {
      return false;
    }
    const preserveCompletedRun = replaceParams.preserveCompletedRun === true;
    const authority = preserveCompletedRun
      ? await captureOperatorToolGatewayContinuationContext()
      : undefined;
    let custodyTransferred = false;
    const runIds = new Set([
      previousRunId,
      nextRunId,
      ...Array.from(
        this.options.getRunsForChildSession(selected.childSessionKey, selected.childAgentId),
        (row) => row.runId,
      ),
      ...(selected.requesterSettleWake?.batchRunIds ?? []),
    ]);
    let replacement: { source: SubagentRunRecord; next: SubagentRunRecord } | undefined;
    let publishedNext: SubagentRunRecord | undefined;
    try {
      replacement = await mutateSubagentRuns(
        [...runIds],
        (rows) => {
          const source = rows.get(previousRunId);
          if (
            !source ||
            !isSameSubagentRunOwner(source, selected) ||
            (preserveCompletedRun &&
              (source.execution.status !== "terminal" ||
                source.pauseReason === "sessions_yield" ||
                previousRunId === nextRunId)) ||
            (replaceParams.expected && !isSameSubagentRunOwner(source, replaceParams.expected)) ||
            (replaceParams.expected &&
              ((typeof source.execution.endedAt === "number" && !replaceParams.allowEndedSource) ||
                source.killReconciliation ||
                source.killIntent)) ||
            !isAgentEventLifecycleGenerationCurrent(lifecycleGeneration)
          ) {
            return { value: undefined };
          }
          if (previousRunId !== nextRunId && rows.get(nextRunId)) {
            throw new SubagentRegistryMutationRejectedError(
              "Replacement subagent id already exists",
            );
          }
          const siblings = [
            ...this.options.getRunsForChildSession(source.childSessionKey, source.childAgentId),
          ];
          if (
            siblings.some((row) => !runIds.has(row.runId)) ||
            (source.requesterSettleWake?.batchRunIds ?? []).some((id) => !runIds.has(id))
          ) {
            throw new SubagentRegistryMutationRejectedError("Replacement subagent cohort changed");
          }
          const now = Date.now();
          const generation = nextSubagentRunGeneration(
            [...siblings, source],
            source.childSessionKey,
            source.childAgentId,
          );
          const spawnMode = source.spawnMode === "session" ? "session" : "run";
          const runTimeoutSeconds =
            replaceParams.runTimeoutSeconds ?? source.runTimeoutSeconds ?? 0;
          const preserveFrozenResultFallback = replaceParams.preserveFrozenResultFallback === true;
          const sessionStartedAt = getSubagentSessionStartedAt(source) ?? now;
          const accumulatedRuntimeMs =
            getSubagentSessionRuntimeMs(
              source,
              typeof source.execution.endedAt === "number" ? source.execution.endedAt : now,
            ) ?? 0;

          // Follow-up work keeps the latest direction in the task's durable record.
          const nextTask =
            typeof replaceParams.task === "string" && replaceParams.task.length > 0
              ? replaceParams.task
              : source.task;
          // The frozen batch is addressed by runId. Adoption retires the previous id,
          // so an unmapped membership list would drop this row from its own batch and
          // let the wave complete without ever waking the requester.
          const sourceRequesterSettleWake = replaceParams.preserveRequesterSettleWake
            ? source.requesterSettleWake
            : undefined;
          const remapRequesterSettleWake = (
            wake: RequesterSettleWakeState,
          ): RequesterSettleWakeState => ({
            ...(wake === sourceRequesterSettleWake && wake.pauseNotice
              ? { ...resetRequesterSettleWakeRetry(wake), pauseNotice: undefined }
              : wake),
            ...(wake.batchRunIds
              ? {
                  batchRunIds: wake.batchRunIds
                    .map((runId) => (runId === previousRunId ? nextRunId : runId))
                    .toSorted(),
                }
              : {}),
          });
          const next: SubagentRunRecord = normalizeSubagentRunState({
            ...source,
            runId: nextRunId,
            // Completed follow-ups start a new task; steer retains its task's lineage.
            taskRunId: preserveCompletedRun ? nextRunId : (source.taskRunId ?? source.runId),
            requesterTurnRunId: preserveCompletedRun ? undefined : source.requesterTurnRunId,
            requesterTurnYielded: preserveCompletedRun ? undefined : source.requesterTurnYielded,
            retireAfterRequesterTurn: preserveCompletedRun
              ? undefined
              : source.retireAfterRequesterTurn,
            task: nextTask,
            generation,
            createdAt: now,
            sessionStartedAt,
            accumulatedRuntimeMs,
            endedReason: undefined,
            pauseReason: undefined,
            endedHookEmittedAt: undefined,
            browserCleanupDispatchedAt: undefined,
            deleteCleanupDispatchedAt: undefined,
            wakeOnDescendantSettle: undefined,
            requesterSettleWake: sourceRequesterSettleWake
              ? remapRequesterSettleWake(sourceRequesterSettleWake)
              : undefined,
            execution: {
              status: "running",
              startedAt: now,
              lifecycleGeneration,
              transcriptTarget: replaceParams.transcriptTarget,
            },
            swarmLaunchPending: false,
            completion: {
              required: source.expectsCompletionMessage === true,
              fallbackResultText: preserveFrozenResultFallback
                ? source.completion?.resultText
                : undefined,
              fallbackCapturedAt: preserveFrozenResultFallback
                ? source.completion?.capturedAt
                : undefined,
            },
            cleanupCompletedAt: undefined,
            cleanupHandled: false,
            suppressAnnounceReason: undefined,
            terminalOwner: undefined,
            killReconciliation: undefined,
            killIntent: undefined,
            suppressCompletionDelivery: undefined,
            spawnMode,
            archiveAtMs: undefined,
            runTimeoutSeconds,
          });
          clearDeliveryState(next);
          const postimages = this.planSupersededKillReconciliations(rows, next);
          for (const memberRunId of sourceRequesterSettleWake?.batchRunIds ?? []) {
            const member = rows.get(memberRunId);
            const wake = member?.requesterSettleWake;
            if (
              !member ||
              memberRunId === previousRunId ||
              memberRunId === nextRunId ||
              member.requesterSessionKey !== source.requesterSessionKey ||
              member.requesterAgentId !== source.requesterAgentId ||
              !wake?.batchRunIds?.includes(previousRunId) ||
              wake.rearmGeneration !== sourceRequesterSettleWake?.rearmGeneration
            ) {
              continue;
            }
            postimages.set(memberRunId, {
              ...(postimages.get(memberRunId) ?? member),
              requesterSettleWake: remapRequesterSettleWake(wake),
            });
          }
          postimages.set(nextRunId, next);
          if (preserveCompletedRun) {
            postimages.set(previousRunId, {
              ...source,
              execution: { ...source.execution, suppressSessionEffects: true },
            });
          } else if (previousRunId !== nextRunId) {
            postimages.set(previousRunId, null);
          }
          return { value: { source, next }, postimages };
        },
        {
          runs: this.options.runs,
          assertCurrent: () => {
            assertCurrent();
            authority?.assertCurrent();
          },
          onPublished: (postimages, value) => {
            const next = postimages.get(nextRunId);
            if (!value || !next) {
              return;
            }
            publishedNext = next;
            bindGatewayContextResolver(
              next,
              replaceParams.gatewayContextResolver ?? getGatewayContextResolver(value.source),
            );
            if (preserveCompletedRun) {
              if (authority?.operatorAuthority) {
                subagentRuns.bindCompletionAuthority(next, authority);
                custodyTransferred = true;
              }
            } else {
              subagentRuns.transferCompletionAuthority(value.source, next);
            }
            subagentRuns.commitOwnership(next);
            replaceParams.onPublished?.(next);
          },
        },
      );
    } catch (error) {
      log.warn("failed to persist replacement subagent recovery run", {
        error,
        previousRunId,
        nextRunId,
      });
      if (replaceParams.lifecycleGeneration !== undefined) {
        return false;
      }
      throw error;
    } finally {
      if (!custodyTransferred) {
        authority?.release();
      }
    }
    if (!replacement) {
      return false;
    }
    const source = replacement.source;
    const next = publishedNext ?? replacement.next;
    if (!isSameSubagentRunOwner(this.options.runs.get(nextRunId), next)) {
      return true;
    }
    if (!preserveCompletedRun) {
      replaceRequesterCronAuthorityEntry({
        previous: source,
        next,
        preserve: replaceParams.preserveRequesterSettleWake === true,
      });
    }
    if (preserveCompletedRun && !source.cleanupHandled) {
      this.options.resumedRuns.delete(getSubagentRunRuntimeKey(source));
      this.options.resumeSubagentRun(previousRunId);
    } else if (!preserveCompletedRun && previousRunId !== nextRunId) {
      this.options.clearPendingLifecycleError(previousRunId);
      this.options.resumedRuns.delete(getSubagentRunRuntimeKey(source));
      if (this.shouldDeleteAttachments(source)) {
        void safeRemoveAttachmentsDir(source);
      }
      if (
        source.execution.transcriptTarget &&
        source.execution.transcriptTarget !== replaceParams.transcriptTarget
      ) {
        const retiredTarget = source.execution.transcriptTarget;
        // The committed replacement owns cleanup beyond its caller's lifetime,
        // including when restart closes admission before this tail settles.
        void runWithGatewayDetachedWorkContinuation(
          () => removeInternalSessionEffectsSession(retiredTarget),
          "subagents:replacement-cleanup",
        ).catch((error: unknown) => {
          log.warn("failed to remove replaced subagent internal session effects", {
            previousRunId,
            nextRunId,
            error,
          });
        });
      }
    }
    this.options.ensureListener();
    // Always start sweeper — session-mode runs (no archiveAtMs) also need TTL cleanup.
    this.options.startSweeper();
    void this.waitForSubagentCompletion(
      nextRunId,
      this.options.resolveSubagentWaitTimeoutMs(
        this.options.getRuntimeConfig(),
        next.runTimeoutSeconds,
      ),
      next,
    );
    return true;
  };
}
