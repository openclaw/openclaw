import { captureSessionWatcherStorePaths } from "../../../config/sessions/session-store-path.js";
import {
  getAgentEventLifecycleGeneration,
  isAgentEventLifecycleGenerationCurrent,
} from "../../../infra/agent-events.js";
import { prepareSubagentTerminalState } from "../../../sessions/subagent-terminal-state.js";
import { createLazyImportLoader } from "../../../shared/lazy-promise.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import { peekSwarmStructuredOutput } from "../../tools/structured-output-tool.js";
import { subagentTerminalTransition } from "../completion/subagent-terminal-transition.js";
import { clearPublishedSwarmCollectorOutput } from "../swarm/swarm-collector.js";
import { resolveSubagentChildAuthority } from "./subagent-child-owner-match.js";
import { resolveSubagentChildSessionOwner } from "./subagent-child-session-owner.js";
import {
  prepareSubagentKillSession,
  type SubagentKillSession,
} from "./subagent-control-session.js";
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
  if (!selectedOwner || resolveSubagentChildAuthority(selectedOwner).status === "mismatch") {
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
    if (
      !suppressSessionEffects &&
      selected.collect &&
      !selected.collectorCompletion &&
      resolveSubagentChildAuthority(selected).status === "verified"
    ) {
      collectorSession = await prepareSubagentKillSession(
        params.getRuntimeConfig(),
        selected.childSessionKey,
        assertCurrent,
        selected.execution.transcriptTarget,
        selected.childAgentId,
        selected.childSessionIdentity,
      );
    }
    const now = Date.now();
    const structuredOutput = selected.collect
      ? (selected.structuredOutput ??
        peekSwarmStructuredOutput(selected.runId) ??
        (selected.swarmRunId ? peekSwarmStructuredOutput(selected.swarmRunId) : undefined))
      : undefined;
    const terminal = subagentTerminalTransition.prepare(
      context,
      selected,
      completeParams,
      now,
      structuredOutput,
    );
    const prepared = {
      now,
      childAgentId: resolveSubagentChildSessionOwner(selected, params.getRuntimeConfig()).agentId,
      watcherStorePaths: captureSessionWatcherStorePaths([selected.requesterSessionKey]),
      suppressSessionEffects,
      structuredOutput,
      capture: terminal.captureRequired
        ? await captureSubagentRunResult(context, selected, terminal.captureOutcome, assertCurrent)
        : undefined,
      collectorSession,
    };
    assertCurrent();
    let settled: ReturnType<typeof subagentTerminalTransition.complete>;
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
            const planned = subagentTerminalTransition.complete(
              context,
              completeParams,
              current,
              prepared,
            );
            if (!planned) {
              return { value: undefined };
            }
            const entry = planned.entry;
            const outcomeStatus = planned.effects.terminalSignalOutcome;
            const terminalEvents = outcomeStatus
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
                context.resumeAncestorCleanup(published);
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
        context.bindTerminalSessionEffects(settled.entry, completeParams.sessionEffects);
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
