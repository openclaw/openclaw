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
import { prepareCanonicalTaskActivation } from "../../../tasks/task-backing-authority-write.js";
import { createSubagentTaskBackingDetail } from "../../../tasks/task-backing-authority.js";
import { removeInternalSessionEffectsSession } from "../../internal-session-effects.js";
import type { AgentRunSessionTarget } from "../../run-session-target.types.js";
import { replaceRequesterCronAuthorityEntry } from "../requester-cron-authority.js";
import {
  clearDeliveryState,
  ensureCompletionState,
  normalizeSubagentRunState,
} from "./subagent-delivery-state.js";
import { safeRemoveAttachmentsDir } from "./subagent-registry-helpers.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { commitSubagentTaskReplacement } from "./subagent-registry-replacement-store.js";
import { SubagentWaitManager } from "./subagent-registry-run-wait.js";
import type { RequesterSettleWakeState, SubagentRunRecord } from "./subagent-registry.types.js";
import { nextSubagentRunGeneration } from "./subagent-run-generation.js";
import {
  getSubagentSessionRuntimeMs,
  getSubagentSessionStartedAt,
} from "./subagent-session-metrics.js";

const log = createSubsystemLogger("agents/subagent-registry");

export class SubagentRecoveryManager extends SubagentWaitManager {
  readonly replaceSubagentRunAfterSteer = (replaceParams: {
    previousRunId: string;
    nextRunId: string;
    fallback?: SubagentRunRecord;
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
  }): boolean => {
    const previousRunId = replaceParams.previousRunId.trim();
    const nextRunId = replaceParams.nextRunId.trim();
    if (!previousRunId || !nextRunId) {
      return false;
    }
    if (
      replaceParams.lifecycleGeneration !== undefined &&
      !isAgentEventLifecycleGenerationCurrent(replaceParams.lifecycleGeneration)
    ) {
      return false;
    }

    const previous = this.options.runs.get(previousRunId);
    if (replaceParams.expected && previous !== replaceParams.expected) {
      return false;
    }
    if (
      replaceParams.expected &&
      previous &&
      ((typeof previous.execution.endedAt === "number" &&
        replaceParams.allowEndedSource !== true) ||
        previous.killReconciliation !== undefined ||
        previous.killIntent !== undefined)
    ) {
      return false;
    }
    const source = previous ?? replaceParams.fallback;
    if (!source) {
      return false;
    }
    const sourceSnapshot = structuredClone(source);

    const now = Date.now();
    const generation = nextSubagentRunGeneration(
      [...this.options.getRunsForChildSession(source.childSessionKey), source],
      source.childSessionKey,
    );
    const cfg = this.options.getRuntimeConfig();
    const spawnMode = source.spawnMode === "session" ? "session" : "run";
    const runTimeoutSeconds = replaceParams.runTimeoutSeconds ?? source.runTimeoutSeconds ?? 0;
    const waitTimeoutMs = this.options.resolveSubagentWaitTimeoutMs(cfg, runTimeoutSeconds);
    const preserveFrozenResultFallback = replaceParams.preserveFrozenResultFallback === true;
    const sessionStartedAt = getSubagentSessionStartedAt(source) ?? now;
    const accumulatedRuntimeMs =
      getSubagentSessionRuntimeMs(
        source,
        typeof source.execution.endedAt === "number" ? source.execution.endedAt : now,
      ) ?? 0;

    const sourceCompletion = ensureCompletionState(source);
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
      ...wake,
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
        lifecycleGeneration:
          replaceParams.lifecycleGeneration ?? getAgentEventLifecycleGeneration(),
        transcriptTarget: replaceParams.transcriptTarget,
      },
      swarmLaunchPending: false,
      completion: {
        required: source.expectsCompletionMessage === true,
        fallbackResultText: preserveFrozenResultFallback ? sourceCompletion.resultText : undefined,
        fallbackCapturedAt: preserveFrozenResultFallback ? sourceCompletion.capturedAt : undefined,
      },
      cleanupCompletedAt: undefined,
      cleanupHandled: false,
      suppressAnnounceReason: undefined,
      terminalOwner: undefined,
      killReconciliation: undefined,
      killIntent: undefined,
      suppressCompletionDelivery: undefined,
      delivery: {
        status: source.expectsCompletionMessage === false ? "not_required" : "pending",
      },
      spawnMode,
      archiveAtMs: undefined,
      runTimeoutSeconds,
      waitExpiryObservedAt: undefined,
      waitExpiryAnnouncedAt: undefined,
    });
    bindGatewayContextResolver(
      next,
      replaceParams.gatewayContextResolver ?? getGatewayContextResolver(source),
    );
    clearDeliveryState(next);

    const taskActivation =
      source.expectsCompletionMessage === false
        ? undefined
        : prepareCanonicalTaskActivation({
            runtime: "subagent",
            childSessionKey: next.childSessionKey,
            runId: source.taskRunId ?? source.runId,
            detail: createSubagentTaskBackingDetail(generation),
            startedAt: now,
            // An admitted kill owns the provisional task projection until its
            // reconciliation settles. An unclaimed marker yields to the admitted
            // successor and must not leave its task cancelled.
            preserveProvisionalCancellation:
              source.killReconciliation?.taskCancellationAccepted === true,
          });

    const restoreCompletionAuthority = subagentRuns.transferCompletionAuthority(source, next);
    if (previousRunId !== nextRunId) {
      this.options.runs.delete(previousRunId);
    }
    this.options.runs.set(nextRunId, next);
    const killReconciliationSnapshots = this.markOlderKillReconciliationsSuperseded(next);
    const wakeSnapshots = new Map<SubagentRunRecord, RequesterSettleWakeState>();
    // Every member carries the frozen cohort. Remap them atomically with the
    // successor so a settled sibling cannot drop a still-running replacement.
    for (const memberRunId of sourceRequesterSettleWake?.batchRunIds ?? []) {
      const member = this.options.runs.get(memberRunId);
      const wake = member?.requesterSettleWake;
      if (
        !member ||
        member === next ||
        member.requesterSessionKey !== source.requesterSessionKey ||
        member.requesterAgentId !== source.requesterAgentId ||
        !wake?.batchRunIds?.includes(previousRunId) ||
        wake.rearmGeneration !== sourceRequesterSettleWake?.rearmGeneration
      ) {
        continue;
      }
      wakeSnapshots.set(member, wake);
      member.requesterSettleWake = remapRequesterSettleWake(wake);
    }
    const changedRunIds = [
      previousRunId,
      nextRunId,
      ...[...killReconciliationSnapshots.keys()].map((entry) => entry.runId),
      ...[...wakeSnapshots.keys()].map((entry) => entry.runId),
    ];
    try {
      if (taskActivation) {
        commitSubagentTaskReplacement({
          runs: this.options.runs,
          changedRunIds,
          source: sourceSnapshot,
          successor: next,
          task: taskActivation,
        });
      } else {
        this.options.persistOrThrow(...changedRunIds);
      }
    } catch (error) {
      restoreCompletionAuthority();
      this.restoreKillReconciliationSnapshots(killReconciliationSnapshots);
      for (const [member, wake] of wakeSnapshots) {
        member.requesterSettleWake = wake;
      }
      this.options.runs.delete(nextRunId);
      this.options.runs.set(previousRunId, source);
      log.warn("failed to persist replacement subagent recovery run; restored source lease", {
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
    // Atomic publication can synchronously trigger another replacement. Do not
    // start stale cleanup or completion work after that newer owner takes over.
    if (this.options.runs.get(nextRunId) !== next) {
      return true;
    }
    replaceRequesterCronAuthorityEntry({
      previous: source,
      next,
      preserve: replaceParams.preserveRequesterSettleWake === true,
    });
    if (!taskActivation) {
      subagentRuns.commitOwnership(next);
    }
    if (previousRunId !== nextRunId) {
      this.options.clearPendingLifecycleError(previousRunId);
      this.options.resumedRuns.delete(previousRunId);
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
    void this.waitForSubagentCompletion(nextRunId, waitTimeoutMs, next);
    return true;
  };
}
