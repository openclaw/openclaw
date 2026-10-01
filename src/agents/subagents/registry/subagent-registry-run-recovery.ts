import type { GatewayContextResolver } from "../../../gateway/server-methods/types.js";
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
        current.childSessionKey !== next.childSessionKey ||
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

  readonly replaceSubagentRunAfterSteer = async (replaceParams: {
    previousRunId: string;
    nextRunId: string;
    expected?: SubagentRunRecord;
    runTimeoutSeconds?: number;
    allowEndedSource?: boolean;
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
    persistenceFailure?: "return-false" | "throw";
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
    const runIds = new Set([
      previousRunId,
      nextRunId,
      ...Array.from(
        this.options.getRunsForChildSession(selected.childSessionKey),
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
          const siblings = [...this.options.getRunsForChildSession(source.childSessionKey)];
          if (
            siblings.some((row) => !runIds.has(row.runId)) ||
            (source.requesterSettleWake?.batchRunIds ?? []).some((id) => !runIds.has(id))
          ) {
            throw new SubagentRegistryMutationRejectedError("Replacement subagent cohort changed");
          }
          const now = Date.now();
          const generation = nextSubagentRunGeneration(
            [...this.options.getRunsForChildSession(source.childSessionKey), source],
            source.childSessionKey,
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
            // Materialize the legacy run-id fallback so later replacements keep the
            // same canonical task owner after this source row is retired.
            taskRunId: source.taskRunId ?? source.runId,
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
          if (previousRunId !== nextRunId) {
            postimages.set(previousRunId, null);
          }
          return { value: { source, next }, postimages };
        },
        {
          runs: this.options.runs,
          assertCurrent,
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
            subagentRuns.transferCompletionAuthority(value.source, next);
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
      if (
        replaceParams.persistenceFailure === "return-false" ||
        replaceParams.lifecycleGeneration !== undefined
      ) {
        return false;
      }
      throw error;
    }
    if (!replacement) {
      return false;
    }
    const source = replacement.source;
    const next = publishedNext ?? replacement.next;
    if (!isSameSubagentRunOwner(this.options.runs.get(nextRunId), next)) {
      return true;
    }
    replaceRequesterCronAuthorityEntry({
      previous: source,
      next,
      preserve: replaceParams.preserveRequesterSettleWake === true,
    });
    if (previousRunId !== nextRunId) {
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
