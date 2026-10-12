import { captureSessionWatcherStorePaths } from "../../../config/sessions/session-store-path.js";
import {
  getAgentEventLifecycleGeneration,
  isAgentEventLifecycleGenerationCurrent,
} from "../../../infra/agent-events.js";
import { prepareSubagentTerminalState } from "../../../sessions/subagent-terminal-state.js";
import { createLazyImportLoader } from "../../../shared/lazy-promise.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import { peekSwarmStructuredOutput } from "../../tools/structured-output-tool.js";
import { withSubagentOutcomeTiming } from "../announce/subagent-announce-output.js";
import { clearPublishedSwarmCollectorOutput } from "../swarm/swarm-collector.js";
import { resolveSubagentChildSessionOwner } from "./subagent-child-session-owner.js";
import {
  prepareSubagentKillSession,
  type SubagentKillSession,
} from "./subagent-control-session.js";
import {} from "./subagent-lifecycle-events.js";
import { shouldDeferTerminalCleanupForUnconfirmedChild } from "./subagent-registry-cleanup.js";
import {
  planTerminalCompletion,
  resolveTerminalRequest,
} from "./subagent-registry-lifecycle-completion-plan.js";
import type { SubagentLifecycleCompletionContext } from "./subagent-registry-lifecycle-context.js";
import { captureSubagentRunResult } from "./subagent-registry-lifecycle-delivery.js";
import { getCurrentSubagentRunOwner } from "./subagent-registry-memory.js";
import {
  assertSubagentRegistryWriteSourceCurrent,
  mutateSubagentRuns,
  SubagentRegistryMutationRejectedError,
} from "./subagent-registry-persistence.js";
import { completeTerminalEffects } from "./subagent-registry-terminal-effects.js";
import type { SubagentCompletionRequest } from "./subagent-registry.types.js";
import { isSameSubagentRunOwner } from "./subagent-run-generation.js";
import {} from "./subagent-run-timeout.js";

const browserCleanupLoader = createLazyImportLoader(
  () => import("../../../browser-lifecycle-cleanup.js"),
);

export async function completeSubagentRunAttempt(
  context: SubagentLifecycleCompletionContext,
  completeParams: SubagentCompletionRequest,
): Promise<void> {
  const params = context.options;
  const stateContext = captureOpenClawStateWorkerContext();
  const selectedOwner = completeParams.expectedEntry
    ? getCurrentSubagentRunOwner(params.runs, completeParams.expectedEntry)
    : params.runs.get(completeParams.runId);
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  if (!selectedOwner) {
    return;
  }
  let releaseCompletionLock: (() => void) | undefined = await context.acquireTerminalCompletionLock(
    selectedOwner.runId,
  );
  let collectorSession: SubagentKillSession | undefined;
  const selected = getCurrentSubagentRunOwner(params.runs, selectedOwner);
  if (!selected) {
    releaseCompletionLock();
    throw new SubagentRegistryMutationRejectedError("Subagent terminal execution changed");
  }
  try {
    const assertCurrent = () => {
      assertSubagentRegistryWriteSourceCurrent(stateContext);
      if (
        !isAgentEventLifecycleGenerationCurrent(lifecycleGeneration) ||
        !getCurrentSubagentRunOwner(params.runs, selected) ||
        completeParams.recoveryCurrent?.isHostCurrent() === false
      ) {
        throw new SubagentRegistryMutationRejectedError("Subagent terminal execution changed");
      }
    };
    const selectedEffects = context.getSessionEffects(selected);
    const assertSessionBinding = () => {
      const current = context.getSessionEffects(selected);
      if (current !== selectedEffects && current !== completeParams.sessionEffects) {
        throw new SubagentRegistryMutationRejectedError(
          "Subagent terminal session-effects binding changed",
        );
      }
    };
    const suppressSessionEffects =
      completeParams.suppressSessionEffects === true ||
      (await context.shouldSuppressSessionEffects(selected, completeParams.sessionEffects));
    if (completeParams.recoveryCurrent && !(await completeParams.recoveryCurrent.prepare())) {
      return;
    }
    assertCurrent();
    assertSessionBinding();
    if (selected.collect && !selected.collectorCompletion) {
      collectorSession = await prepareSubagentKillSession(
        params.getRuntimeConfig(),
        selected.childSessionKey,
        assertCurrent,
        selected.execution.transcriptTarget,
        selected.childAgentId,
      );
    }
    const now = Date.now();
    const structuredOutput = selected.collect
      ? (selected.structuredOutput ??
        peekSwarmStructuredOutput(selected.runId) ??
        (selected.swarmRunId ? peekSwarmStructuredOutput(selected.swarmRunId) : undefined))
      : undefined;
    const terminal = resolveTerminalRequest(selected, completeParams, now, structuredOutput);
    const captureOutcome = withSubagentOutcomeTiming(terminal.completionOutcome, {
      startedAt: terminal.observedStartedAt ?? selected.execution.startedAt,
      endedAt: terminal.endedAt,
    });
    const prepared = {
      now,
      childAgentId: resolveSubagentChildSessionOwner(selected, params.getRuntimeConfig()).agentId,
      watcherStorePaths: captureSessionWatcherStorePaths([selected.requesterSessionKey]),
      suppressSessionEffects,
      structuredOutput,
      capture:
        completeParams.recoverInterrupted ||
        context.newerGenerationOwnsSession(selected) ||
        terminal.terminalReply ||
        (terminal.missingRequiredReply && terminal.completionOutcome.status === "ok") ||
        completeParams.completionSnapshot
          ? undefined
          : await captureSubagentRunResult(context, selected, captureOutcome, assertCurrent),
      collectorSession,
    };
    assertCurrent();
    let settled: ReturnType<typeof planTerminalCompletion>;
    let terminalGeneration = 0;
    let publishesTerminalSignal = false;
    try {
      const commit = () =>
        mutateSubagentRuns(
          [selected.runId],
          (rows) => {
            const current = rows.get(selected.runId);
            if (
              !current ||
              !isSameSubagentRunOwner(current, selected) ||
              current.requesterSessionKey !== selected.requesterSessionKey
            ) {
              throw new SubagentRegistryMutationRejectedError(
                "Subagent terminal execution changed",
              );
            }
            assertSessionBinding();
            const planned = planTerminalCompletion(context, completeParams, current, prepared);
            if (!planned) {
              return { value: undefined };
            }
            const entry = planned.entry;
            const outcomeStatus = entry.execution.outcome?.status;
            const terminalEvents =
              !planned.suppressSessionEffects &&
              !planned.sessionSuperseded &&
              entry.killReconciliation === undefined &&
              // The `run-terminal:<runId>` dedupe key is first-write-wins, so a
              // provisional status published here could never be replaced by the
              // truthful one. A `child-unconfirmed` row is provisional in exactly
              // that sense: nothing observed the child stop, so "child run timed
              // out" would tell every signal-log observer that a possibly-live
              // child died. Promotion re-enters this owner with an observed
              // disposition and publishes the signal then.
              !shouldDeferTerminalCleanupForUnconfirmedChild(entry) &&
              outcomeStatus &&
              outcomeStatus !== "unknown"
                ? [
                    prepareSubagentTerminalState(
                      {
                        childSessionKey: entry.childSessionKey,
                        agentId: prepared.childAgentId,
                        runId: entry.runId,
                        requesterSessionKey: entry.requesterSessionKey,
                        outcomeStatus,
                        watcherStorePaths: prepared.watcherStorePaths,
                        sessionEntryCurrent: (
                          completeParams.sessionEffects ?? context.getSessionEffects(current)
                        )?.nativeCheck,
                      },
                      prepared.now,
                    ),
                  ]
                : undefined;
            publishesTerminalSignal = terminalEvents !== undefined;
            return {
              value: planned,
              postimages: planned.mutated ? new Map([[entry.runId, entry]]) : undefined,
              terminalEvents,
            };
          },
          {
            runs: params.runs,
            context: stateContext,
            onPublished: (postimages, planned) => {
              if (planned) {
                const published = postimages.get(planned.entry.runId) ?? planned.entry;
                completeParams.recoveryCurrent?.onPublished?.(published);
                clearPublishedSwarmCollectorOutput(published);
              }
            },
            assertCurrent: () => {
              assertCurrent();
              assertSessionBinding();
              collectorSession?.assertCurrent();
              if (publishesTerminalSignal && context.newerGenerationOwnsSession(selected)) {
                throw new SubagentRegistryMutationRejectedError(
                  "Subagent terminal signal session changed",
                );
              }
              if (!suppressSessionEffects) {
                (
                  completeParams.sessionEffects ?? context.getSessionEffects(selected)
                )?.assertHostCurrent();
              }
            },
          },
        );
      settled = collectorSession ? await collectorSession.withPublication(commit) : await commit();
      if (settled) {
        const bindingChanged =
          completeParams.sessionEffects !== undefined &&
          context.getSessionEffects(settled.entry) !== completeParams.sessionEffects;
        context.bindTerminalSessionEffects(settled.entry, completeParams.sessionEffects);
        terminalGeneration = context.bumpTerminalGeneration(settled.entry, bindingChanged);
        if (settled.replacedProvisionalKill) {
          context.bumpCleanupGeneration(settled.entry);
        }
        const published = getCurrentSubagentRunOwner(params.runs, settled.entry);
        if (published) {
          params.clearPendingLifecycleError(published.runId);
        }
      }
    } finally {
      releaseCompletionLock?.();
      releaseCompletionLock = undefined;
    }
    if (!settled) {
      return;
    }
    await completeTerminalEffects(context, {
      completeParams,
      ...settled,
      terminalGeneration,
      stateContext,
      assertCurrent,
      loadCleanupBrowserSessionsForLifecycleEnd:
        params.loadCleanupBrowserSessionsForLifecycleEnd ??
        (async () => (await browserCleanupLoader.load()).cleanupBrowserSessionsForLifecycleEnd),
    });
  } finally {
    releaseCompletionLock?.();
    await collectorSession?.release();
  }
}
