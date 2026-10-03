import type { cleanupBrowserSessionsForLifecycleEnd } from "../../../browser-lifecycle-cleanup.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../../infra/sqlite-worker-contract.js";
import { emitSessionLifecycleEvent } from "../../../sessions/session-lifecycle-events.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import { retireSessionMcpRuntimeForSessionKey } from "../../agent-bundle-mcp-tools.js";
import { releaseSwarmRun } from "../swarm/swarm-scheduler.js";
import {
  SUBAGENT_ENDED_REASON_KILLED,
  type SubagentLifecycleEndedReason,
} from "./subagent-lifecycle-events.js";
import { persistSubagentSessionTiming } from "./subagent-registry-helpers.js";
import type { SubagentLifecycleCompletionContext } from "./subagent-registry-lifecycle-context.js";
import {
  buildSafeLifecycleErrorMeta,
  maskLifecycleIdentifier,
} from "./subagent-registry-lifecycle-log.js";
import { commitSubagentLifecycleMutation } from "./subagent-registry-lifecycle-persistence.js";
import { getCurrentSubagentRunOwner } from "./subagent-registry-memory.js";
import { SubagentRegistryWriteError } from "./subagent-registry-persistence.js";
import type { SubagentCompletionRequest, SubagentRunRecord } from "./subagent-registry.types.js";
import { getSubagentRunRuntimeKey } from "./subagent-run-generation.js";

type BrowserCleanup = typeof cleanupBrowserSessionsForLifecycleEnd;

export async function completeTerminalEffects(
  context: SubagentLifecycleCompletionContext,
  args: {
    completeParams: SubagentCompletionRequest;
    completionReason: SubagentLifecycleEndedReason;
    entry: SubagentRunRecord;
    mutated: boolean;
    sessionSuperseded: boolean;
    suppressSessionEffects: boolean;
    terminalGeneration: number;
    stateContext: OpenClawStateWorkerContext;
    assertCurrent: () => void;
    loadCleanupBrowserSessionsForLifecycleEnd(): Promise<BrowserCleanup>;
  },
): Promise<void> {
  const params = context.options;
  const { completeParams, completionReason, mutated } = args;
  let terminalGeneration = args.terminalGeneration;
  let entry = args.entry;
  let { sessionSuperseded, suppressSessionEffects } = args;
  const isCurrentTerminalCallback = () => {
    if (!context.isTerminalCallbackCurrent(completeParams.runId, entry, terminalGeneration)) {
      return false;
    }
    args.assertCurrent();
    entry = getCurrentSubagentRunOwner(params.runs, entry)!;
    return true;
  };
  const isCurrentSessionEffectsOwner = () =>
    isCurrentTerminalCallback() &&
    !context.newerGenerationOwnsSession(entry) &&
    context.sessionEffectsHostCurrent(entry);
  const persistSessionEffectsSuppression = async () => {
    entry = await commitSubagentLifecycleMutation(context, {
      entry,
      stateContext: args.stateContext,
      assertCurrent: () => {
        if (!isCurrentTerminalCallback()) {
          throw new Error("Subagent terminal effects lost their original generation");
        }
      },
      mutate: (draft) => {
        draft.execution = { ...draft.execution, suppressSessionEffects: true };
      },
    });
    terminalGeneration = context.bumpTerminalGeneration(entry);
  };
  const refreshSessionEffectsSuppression = async () => {
    const suppressed = await context.shouldSuppressSessionEffects(entry);
    if (!isCurrentTerminalCallback()) {
      return true;
    }
    if (!suppressed) {
      return false;
    }
    suppressSessionEffects = true;
    if (entry.execution.suppressSessionEffects !== true) {
      await persistSessionEffectsSuppression();
    }
    return true;
  };
  if (!isCurrentTerminalCallback()) {
    return;
  }
  const retireSupersededSession = async (currentEntry: SubagentRunRecord) => {
    if (completionReason !== SUBAGENT_ENDED_REASON_KILLED) {
      await params.retireSupersededRun(currentEntry.runId, currentEntry);
    }
  };
  const warnMeta = (error: unknown) => ({
    error: buildSafeLifecycleErrorMeta(error),
    runId: maskLifecycleIdentifier(completeParams.runId, "run"),
    childSessionKey: maskLifecycleIdentifier(entry.childSessionKey, "session"),
  });
  sessionSuperseded ||= context.newerGenerationOwnsSession(entry);
  if (sessionSuperseded) {
    // This callback belongs to an older run that shared the session key.
    // Retire the old run; the newer generation owns all session effects.
    await retireSupersededSession(entry);
    return;
  }
  if (entry.collect) {
    releaseSwarmRun(entry.schedulerSlotId ?? entry.runId);
  }
  await refreshSessionEffectsSuppression();
  if (!isCurrentTerminalCallback()) {
    return;
  }
  const isProvisionalKill = entry.killReconciliation !== undefined;

  if (!suppressSessionEffects) {
    try {
      const assertSessionEffectsOwnerCurrent = () => {
        if (!isCurrentSessionEffectsOwner()) {
          throw new Error("subagent session-effects owner retired before session commit");
        }
      };
      await persistSubagentSessionTiming(entry, {
        // Recheck at replacement admission so an old completion cannot commit
        // after session ownership transfers.
        isCurrentGeneration: isCurrentSessionEffectsOwner,
        assertCommitAllowed: assertSessionEffectsOwnerCurrent,
        assertCurrentEntry: context.getSessionEffects(entry)?.assertCurrentEntry,
        sessionEntryCurrent: context.getSessionEffects(entry)?.nativeCheck,
      });
    } catch (err) {
      if (hasSqliteWorkerOutcomeUnknown(err)) {
        throw err;
      }
      params.warn("failed to persist subagent session timing", {
        err,
        runId: entry.runId,
        childSessionKey: entry.childSessionKey,
      });
    }
  }
  await refreshSessionEffectsSuppression();
  if (!isCurrentTerminalCallback()) {
    return;
  }
  if (context.newerGenerationOwnsSession(entry)) {
    await retireSupersededSession(entry);
    return;
  }

  const suppressedForSteerRestart = params.suppressAnnounceForSteerRestart(entry);
  // Recovery persists its terminal state before draining this callback, so an
  // unchanged row still needs its first session-status and progress events.
  const shouldPublishTerminalStatus =
    mutated ||
    (completeParams.recoverInterrupted === true &&
      !isProvisionalKill &&
      !context.progressEndedEntries.has(getSubagentRunRuntimeKey(entry)));
  if (
    shouldPublishTerminalStatus &&
    !suppressedForSteerRestart &&
    !suppressSessionEffects &&
    isCurrentSessionEffectsOwner()
  ) {
    emitSessionLifecycleEvent({
      sessionKey: entry.childSessionKey,
      reason: "subagent-status",
      parentSessionKey: entry.requesterSessionKey,
      label: entry.label,
    });
    // The enclosing steer/session-effects guard admits only the real terminal generation.
    if (!isProvisionalKill && !context.progressEndedEntries.has(getSubagentRunRuntimeKey(entry))) {
      context.progressEndedEntries.add(getSubagentRunRuntimeKey(entry));
      await params.emitSubagentProgressEndedForRun(entry);
      await refreshSessionEffectsSuppression();
      if (!isCurrentTerminalCallback()) {
        return;
      }
    }
  }
  const shouldEmitEndedHook =
    !suppressedForSteerRestart &&
    !isProvisionalKill &&
    !suppressSessionEffects &&
    params.shouldEmitEndedHookForRun({ entry, reason: completionReason });
  const shouldDeferEndedHook =
    shouldEmitEndedHook && completeParams.triggerCleanup && entry.expectsCompletionMessage === true;
  if (!shouldDeferEndedHook && shouldEmitEndedHook) {
    await params.emitSubagentEndedHookForRun({
      entry,
      reason: completionReason,
      sendFarewell: completeParams.sendFarewell,
      accountId: completeParams.accountId,
      isCurrent: isCurrentSessionEffectsOwner,
      prepareCurrent: async () =>
        !(await context.shouldSuppressSessionEffects(entry)) && isCurrentSessionEffectsOwner(),
    });
    await refreshSessionEffectsSuppression();
    if (!isCurrentTerminalCallback()) {
      return;
    }
    if (context.newerGenerationOwnsSession(entry)) {
      await retireSupersededSession(entry);
      return;
    }
  }

  await refreshSessionEffectsSuppression();
  // Cleanup also rejects newer session generations, but host custody is checked
  // at each resource dispatch rather than shared with terminal-signal admission.
  const isSessionEffectsOwnerCurrent = () =>
    isCurrentTerminalCallback() && !context.newerGenerationOwnsSession(entry);
  const refreshCleanupSuppression = async () => {
    if (
      suppressSessionEffects ||
      !isSessionEffectsOwnerCurrent() ||
      !(await context.shouldSuppressSessionEffects(entry)) ||
      !isSessionEffectsOwnerCurrent()
    ) {
      return suppressSessionEffects;
    }
    await persistSessionEffectsSuppression();
    suppressSessionEffects = true;
    return true;
  };
  if (!completeParams.triggerCleanup || suppressedForSteerRestart) {
    return;
  }

  await refreshCleanupSuppression();
  if (!isCurrentTerminalCallback()) {
    return;
  }
  if (context.newerGenerationOwnsSession(entry)) {
    await retireSupersededSession(entry);
    return;
  }

  // registerSubagentRun fires both an in-process listener and a gateway
  // waitForSubagentCompletion RPC; both can reach this point for the same
  // runId in embedded mode. Dedupe only the browser driver tab-close IPC
  // with an admitted claim. The retire + announce tail below must still
  // run for every caller, so a slow or held first browser cleanup cannot
  // strand a duplicate caller's completion behind it.
  if (!suppressSessionEffects && entry.browserCleanupDispatchedAt === undefined) {
    let dispatchedBrowserCleanup = false;
    let cleanupBrowserSessions: typeof cleanupBrowserSessionsForLifecycleEnd | undefined =
      params.cleanupBrowserSessionsForLifecycleEnd;
    try {
      cleanupBrowserSessions ??= await args.loadCleanupBrowserSessionsForLifecycleEnd();
    } catch (error) {
      params.warn("failed to load browser cleanup for completed subagent", warnMeta(error));
    }
    if (cleanupBrowserSessions) {
      if (!isCurrentTerminalCallback()) {
        return;
      }
      if (context.newerGenerationOwnsSession(entry)) {
        await retireSupersededSession(entry);
        return;
      }
      // Claim only when this caller is about to dispatch. A concurrent caller
      // may have claimed while the lazy browser module was loading.
      if (
        !(await refreshCleanupSuppression()) &&
        isSessionEffectsOwnerCurrent() &&
        entry.browserCleanupDispatchedAt === undefined
      ) {
        const retiredOwner = new Error("Subagent browser cleanup lost its original owner");
        try {
          entry = await commitSubagentLifecycleMutation(context, {
            entry,
            stateContext: args.stateContext,
            assertCurrent: () => {
              if (!isSessionEffectsOwnerCurrent()) {
                throw retiredOwner;
              }
            },
            mutate: (draft) => {
              if (draft.browserCleanupDispatchedAt !== undefined) {
                return false;
              }
              draft.browserCleanupDispatchedAt = Date.now();
              return undefined;
            },
            onPublished: () => {
              dispatchedBrowserCleanup = true;
            },
          });
        } catch (error) {
          // A newer terminal publication can retire this callback while its
          // cleanup claim waits for persistence. Only that pre-commit refusal
          // is harmless; persistence and unknown-outcome failures must propagate.
          if (
            error === retiredOwner ||
            (error instanceof SubagentRegistryWriteError &&
              error.outcome === "not-committed" &&
              error.cause === retiredOwner)
          ) {
            if (isCurrentTerminalCallback() && context.newerGenerationOwnsSession(entry)) {
              await retireSupersededSession(entry);
            }
            return;
          }
          throw error;
        }
        if (dispatchedBrowserCleanup) {
          if (!isSessionEffectsOwnerCurrent() || !context.sessionEffectsHostCurrent(entry)) {
            return;
          }
          try {
            await cleanupBrowserSessions({
              sessionKeys: [entry.childSessionKey],
              isCurrent: () =>
                isSessionEffectsOwnerCurrent() && context.sessionEffectsHostCurrent(entry),
              prepareCurrent: async () =>
                !(await context.shouldSuppressSessionEffects(entry)) &&
                isSessionEffectsOwnerCurrent(),
              sessionEntryCurrent: context.getSessionEffects(entry)?.nativeCheck,
              onWarn: (msg) => params.warn(msg, { runId: entry.runId }),
            });
          } catch (error) {
            params.warn(
              "failed to cleanup browser sessions for completed subagent",
              warnMeta(error),
            );
          }
        }
      }
    }
    if (dispatchedBrowserCleanup) {
      if (!isCurrentTerminalCallback()) {
        return;
      }
      await refreshCleanupSuppression();
      if (context.newerGenerationOwnsSession(entry)) {
        await retireSupersededSession(entry);
        return;
      }
    }
  }

  if (!suppressSessionEffects) {
    if (!isCurrentTerminalCallback()) {
      return;
    }
    if (context.newerGenerationOwnsSession(entry)) {
      await retireSupersededSession(entry);
      return;
    }
    try {
      if (entry.spawnMode !== "session") {
        const cleanupEntry = entry;
        await retireSessionMcpRuntimeForSessionKey({
          sessionKey: cleanupEntry.childSessionKey,
          reason: "subagent-run-complete",
          preserveActiveLeases: true,
          onError: (error, sessionId) => {
            params.warn("failed to retire subagent bundle MCP runtime", {
              error: buildSafeLifecycleErrorMeta(error),
              sessionId,
              runId: maskLifecycleIdentifier(cleanupEntry.runId, "run"),
              childSessionKey: maskLifecycleIdentifier(cleanupEntry.childSessionKey, "session"),
            });
          },
        });
      }
    } catch (error) {
      params.warn("failed to retire subagent bundle MCP runtime after completion", warnMeta(error));
    }
    if (!isCurrentTerminalCallback()) {
      return;
    }
    await refreshCleanupSuppression();
    if (context.newerGenerationOwnsSession(entry)) {
      await retireSupersededSession(entry);
      return;
    }
  }

  if (isProvisionalKill) {
    // Browser and MCP resources can close immediately, but completion delivery
    // waits for the provider result or the killed tombstone reconciliation.
    return;
  }

  await refreshCleanupSuppression();
  if (isCurrentTerminalCallback()) {
    context.startSubagentAnnounceCleanupFlow(entry.runId, entry);
  }
}
