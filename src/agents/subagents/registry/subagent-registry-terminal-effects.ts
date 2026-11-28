import type { cleanupBrowserSessionsForLifecycleEnd } from "../../../browser-lifecycle-cleanup.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../../infra/sqlite-worker-contract.js";
import { scopeLegacySessionKeyToAgent } from "../../../routing/session-key.js";
import { emitSessionLifecycleEvent } from "../../../sessions/session-lifecycle-events.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import { retireSessionMcpRuntime } from "../../agent-bundle-mcp-tools.js";
import type { subagentTerminalTransition } from "../completion/subagent-terminal-transition.js";
import { releaseSwarmRun } from "../swarm/swarm-scheduler.js";
import { resolveSubagentChildAuthority } from "./subagent-child-owner-match.js";
import type { SubagentLifecycleEndedReason } from "./subagent-lifecycle-events.js";
import { persistSubagentSessionTiming } from "./subagent-registry-helpers.js";
import type { SubagentLifecycleCompletionContext } from "./subagent-registry-lifecycle-context.js";
import { buildSafeLifecycleErrorMeta } from "./subagent-registry-lifecycle-log.js";
import {
  commitSubagentLifecycleMutation,
  SubagentLifecycleOwnerChangedError,
} from "./subagent-registry-lifecycle-persistence.js";
import { getCurrentSubagentRunOwner } from "./subagent-registry-memory.js";
import { SubagentRegistryWriteError } from "./subagent-registry-persistence.js";
import type { SubagentCompletionRequest, SubagentRunRecord } from "./subagent-registry.types.js";
import { getSubagentRunRuntimeKey } from "./subagent-run-generation.js";

export async function completeTerminalEffects(
  context: SubagentLifecycleCompletionContext,
  args: {
    completeParams: SubagentCompletionRequest;
    completionReason: SubagentLifecycleEndedReason;
    entry: SubagentRunRecord;
    effects: NonNullable<ReturnType<typeof subagentTerminalTransition.complete>>["effects"];
    sessionSuperseded: boolean;
    suppressSessionEffects: boolean;
    stateContext: OpenClawStateWorkerContext;
    assertCurrent: () => void;
    loadCleanupBrowserSessionsForLifecycleEnd(): Promise<
      typeof cleanupBrowserSessionsForLifecycleEnd
    >;
  },
): Promise<void> {
  const params = context.options;
  const { completeParams, completionReason, effects } = args;
  let entry = args.entry;
  if (resolveSubagentChildAuthority(entry).status === "mismatch") {
    return;
  }
  let { sessionSuperseded, suppressSessionEffects } = args;
  const sessionEffects = context.getSessionEffects(entry);
  const isCurrentTerminalCallback = () => {
    if (
      !context.isTerminalExecutionCurrent(entry) ||
      context.getSessionEffects(entry) !== sessionEffects
    ) {
      return false;
    }
    args.assertCurrent();
    entry = getCurrentSubagentRunOwner(params.runs, entry)!;
    return true;
  };
  const isSessionEffectsOwnerCurrent = () =>
    isCurrentTerminalCallback() && !context.newerGenerationOwnsSession(entry);
  const isCurrentSessionEffectsOwner = () =>
    isSessionEffectsOwnerCurrent() && context.sessionEffectsHostCurrent(entry);
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
  // Cleanup also rejects newer session generations, but host custody is checked
  // at each resource dispatch rather than shared with terminal-signal admission.
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
  // Continuing must stay synchronous until dispatch: a yield could transfer session ownership.
  const stopTerminalEffects = (): Promise<void> | undefined => {
    if (!isCurrentTerminalCallback()) {
      return Promise.resolve();
    }
    sessionSuperseded ||= context.newerGenerationOwnsSession(entry);
    if (!sessionSuperseded) {
      return undefined;
    }
    return effects.retireSuperseded
      ? params.retireSupersededRun(entry.runId, entry)
      : Promise.resolve();
  };
  const warnMeta = (error: unknown) => ({
    error: buildSafeLifecycleErrorMeta(error),
    runId: completeParams.runId,
    childSessionKey: entry.childSessionKey,
  });
  let terminalStop: Promise<void> | undefined;

  // One ordered effect path. Every asynchronous stage refreshes the same owner
  // before the next dispatch; only session-scoped stages stop for suppression.
  for (const [phase, prepare, sessionScoped] of [
    ["release", undefined, false],
    ["timing", refreshSessionEffectsSuppression, true],
    ["status", refreshSessionEffectsSuppression, true],
    ["ended-hook", refreshSessionEffectsSuppression, true],
    ["cleanup", refreshSessionEffectsSuppression, false],
    ["browser", refreshCleanupSuppression, true],
    ["mcp", refreshCleanupSuppression, true],
    ["announce", refreshCleanupSuppression, false],
  ] as const) {
    if (prepare) {
      await prepare();
    }
    if ((terminalStop = stopTerminalEffects())) {
      await terminalStop;
      return;
    }
    if (sessionScoped && suppressSessionEffects) {
      continue;
    }
    switch (phase) {
      case "release":
        if (effects.releaseSwarm) {
          releaseSwarmRun(entry.schedulerSlotId ?? entry.runId);
        }
        break;
      case "timing": {
        // Duplicate receipts drain cleanup without replaying best-effort timing writes.
        if (effects.persistTiming) {
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
        break;
      }
      case "status": {
        if (effects.publishStatus && isCurrentSessionEffectsOwner()) {
          emitSessionLifecycleEvent({
            sessionKey: entry.childSessionKey,
            reason: "subagent-status",
            parentSessionKey: entry.requesterSessionKey,
            label: entry.label,
          });
          // The enclosing steer/session-effects guard admits only the real terminal generation.
          if (
            effects.publishProgress &&
            !context.progressEndedEntries.has(getSubagentRunRuntimeKey(entry))
          ) {
            context.progressEndedEntries.add(getSubagentRunRuntimeKey(entry));
            await params.emitSubagentProgressEndedForRun(entry);
          }
        }
        break;
      }
      case "ended-hook": {
        const shouldEmitEndedHook =
          effects.endedHook &&
          params.shouldEmitEndedHookForRun({ entry, reason: completionReason });
        if (shouldEmitEndedHook && !effects.deferEndedHook) {
          await params.emitSubagentEndedHookForRun({
            entry,
            reason: completionReason,
            sendFarewell: completeParams.sendFarewell,
            accountId: completeParams.accountId,
            isCurrent: isCurrentSessionEffectsOwner,
            prepareCurrent: async () =>
              !(await context.shouldSuppressSessionEffects(entry)) &&
              isCurrentSessionEffectsOwner(),
          });
        }
        break;
      }
      case "cleanup":
        if (!effects.cleanup) {
          return;
        }
        break;
      case "browser": {
        // registerSubagentRun fires both an in-process listener and a gateway
        // waitForSubagentCompletion RPC; both can reach this point for the same
        // runId in embedded mode. Dedupe only the browser driver tab-close IPC
        // with an admitted claim. The retire + announce tail below must still
        // run for every caller, so a slow or held first browser cleanup cannot
        // strand a duplicate caller's completion behind it.
        if (entry.browserCleanupDispatchedAt === undefined) {
          let dispatchedBrowserCleanup = false;
          let cleanupBrowserSessions: typeof cleanupBrowserSessionsForLifecycleEnd | undefined =
            params.cleanupBrowserSessionsForLifecycleEnd;
          try {
            cleanupBrowserSessions ??= await args.loadCleanupBrowserSessionsForLifecycleEnd();
          } catch (error) {
            params.warn("failed to load browser cleanup for completed subagent", warnMeta(error));
          }
          if (cleanupBrowserSessions) {
            if ((terminalStop = stopTerminalEffects())) {
              await terminalStop;
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
                const rejection =
                  error instanceof SubagentRegistryWriteError && error.outcome === "not-committed"
                    ? error.cause
                    : error;
                if (
                  rejection === retiredOwner ||
                  rejection instanceof SubagentLifecycleOwnerChangedError
                ) {
                  await stopTerminalEffects();
                  return;
                }
                throw error;
              }
              if (dispatchedBrowserCleanup) {
                if (!isCurrentSessionEffectsOwner()) {
                  return;
                }
                try {
                  await cleanupBrowserSessions({
                    sessionKeys: [
                      scopeLegacySessionKeyToAgent({
                        agentId: entry.childAgentId,
                        sessionKey: entry.childSessionKey,
                      }) ?? "",
                    ],
                    isCurrent: isCurrentSessionEffectsOwner,
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
        }
        break;
      }
      case "mcp": {
        try {
          if (effects.retireMcp) {
            const cleanupEntry = entry;
            await retireSessionMcpRuntime({
              sessionId: cleanupEntry.childSessionIdentity?.sessionId,
              reason: "subagent-run-complete",
              preserveActiveLeases: true,
              onError: (error, sessionId) => {
                params.warn("failed to retire subagent bundle MCP runtime", {
                  error: buildSafeLifecycleErrorMeta(error),
                  sessionId,
                  runId: cleanupEntry.runId,
                  childSessionKey: cleanupEntry.childSessionKey,
                });
              },
            });
          }
        } catch (error) {
          params.warn(
            "failed to retire subagent bundle MCP runtime after completion",
            warnMeta(error),
          );
        }
        break;
      }
      case "announce":
        // Resource cleanup can finish before the controller confirms a provisional kill.
        if (effects.cleanupTail === "confirm-kill") {
          params.confirmProvisionalKill(entry);
        } else {
          context.startSubagentAnnounceCleanupFlow(entry);
        }
        return;
    }
  }
}
