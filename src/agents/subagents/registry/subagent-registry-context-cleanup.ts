import { getRuntimeConfig } from "../../../config/config.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../../infra/sqlite-worker-contract.js";
import { withPluginRuntimeRegistryScope } from "../../../plugins/runtime/gateway-request-scope.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import { removeInternalSessionEffectsSession } from "../../internal-session-effects.js";
import {
  SUBAGENT_ENDED_OUTCOME_KILLED,
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_KILLED,
  type SubagentLifecycleEndedReason,
} from "./subagent-lifecycle-events.js";
import {
  emitSubagentEndedHookOnce,
  resolveLifecycleOutcomeFromRunOutcome,
} from "./subagent-registry-completion.js";
import {
  loadSubagentRegistryPluginRuntimeHandle,
  resolveSubagentRegistryContextEngine,
} from "./subagent-registry-deps.js";
import { safeRemoveAttachmentsDir } from "./subagent-registry-helpers.js";
import { getCurrentSubagentRunOwner, subagentRuns } from "./subagent-registry-memory.js";
import {
  assertSubagentRegistryWriteOutcomeKnown,
  assertSubagentRegistryWriteSourceCurrent,
  mutateSubagentRuns,
  SubagentRegistryMutationRejectedError,
} from "./subagent-registry-persistence.js";
import type {
  ContextEngineSubagentEndedParams,
  SubagentRunRecord,
} from "./subagent-registry.types.js";
import { getSubagentRunRuntimeKey, isSameSubagentRunOwner } from "./subagent-run-generation.js";

export function createSubagentRegistryContextCleanup(config: {
  isEndedHookOwnerCurrent: (runId: string, entry: SubagentRunRecord) => boolean;
  warn: (message: string, meta?: Record<string, unknown>) => void;
}) {
  const { warn } = config;
  const endedHookInFlightOwners = new Set<object>();
  const endedHookEmittedOwners = new WeakSet<object>();

  async function runContextEngineSubagentEnded(
    params: ContextEngineSubagentEndedParams,
    options?: { isCurrent?: () => boolean; prepareCurrent?: () => Promise<boolean> },
  ): Promise<void> {
    const cfg = getRuntimeConfig();
    const registry = await loadSubagentRegistryPluginRuntimeHandle({
      config: cfg,
      ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
      allowGatewaySubagentBinding: true,
    });
    await withPluginRuntimeRegistryScope(registry, async () => {
      const engine = await resolveSubagentRegistryContextEngine(cfg, {
        agentDir: params.agentDir,
        workspaceDir: params.workspaceDir,
      });
      let failure: { error: unknown } | undefined;
      try {
        if ((await options?.prepareCurrent?.()) !== false && options?.isCurrent?.() !== false) {
          await engine.onSubagentEnded?.(params);
        }
      } catch (error) {
        failure = { error };
      }
      try {
        await engine.dispose?.();
      } catch (error) {
        failure ??= { error };
      }
      if (failure) {
        throw failure.error;
      }
    });
  }

  async function tryContextEngineSubagentEnded(
    params: ContextEngineSubagentEndedParams,
    warning: string,
    options?: { isCurrent?: () => boolean; prepareCurrent?: () => Promise<boolean> },
  ): Promise<boolean> {
    try {
      await runContextEngineSubagentEnded(params, options);
      return true;
    } catch (err) {
      warn(warning, { err });
      return false;
    }
  }

  async function notifyContextEngineSubagentEnded(
    params: ContextEngineSubagentEndedParams,
    options?: { isCurrent?: () => boolean; prepareCurrent?: () => Promise<boolean> },
  ): Promise<void> {
    await tryContextEngineSubagentEnded(
      params,
      "context-engine onSubagentEnded failed (best-effort)",
      options,
    );
  }

  async function cleanupCollectorLaunchResources(
    observedEntry: SubagentRunRecord,
    options?: { isCurrent?: () => boolean },
  ): Promise<boolean> {
    let entry = observedEntry;
    const stateContext = captureOpenClawStateWorkerContext();
    const isCurrent = () => {
      assertSubagentRegistryWriteSourceCurrent(stateContext);
      const current = getCurrentSubagentRunOwner(subagentRuns, observedEntry);
      if (!current) {
        return false;
      }
      entry = current;
      return options?.isCurrent?.() !== false;
    };
    let internalEffectsRemoved = true;
    if (isCurrent()) {
      try {
        await removeInternalSessionEffectsSession(entry.execution.transcriptTarget);
      } catch (err) {
        internalEffectsRemoved = false;
        warn("failed to remove collector internal session effects", {
          runId: entry.runId,
          childSessionKey: entry.childSessionKey,
          err,
        });
      }
    }
    const contextAlreadyEnded = typeof entry.contextEngineCleanupCompletedAt === "number";
    const attachmentsRemoved = await safeRemoveAttachmentsDir(entry, isCurrent);
    if (!isCurrent()) {
      return false;
    }
    const contextEnded = contextAlreadyEnded
      ? true
      : await tryContextEngineSubagentEnded(
          {
            childSessionKey: entry.childSessionKey,
            reason: "deleted",
            agentDir: entry.agentDir,
            workspaceDir: entry.workspaceDir,
          },
          "context-engine collector cleanup failed",
          { isCurrent },
        );
    if (!contextAlreadyEnded && contextEnded && isCurrent()) {
      const runId = entry.runId;
      const assertCurrent = () => {
        if (!isCurrent() || entry.runId !== runId) {
          throw new SubagentRegistryMutationRejectedError(
            "Collector cleanup address changed before persistence.",
          );
        }
      };
      await mutateSubagentRuns(
        [runId],
        (rows) => {
          assertCurrent();
          const current = rows.get(runId);
          if (!current || !isSameSubagentRunOwner(current, entry) || !isCurrent()) {
            throw new SubagentRegistryMutationRejectedError("Collector cleanup execution changed.");
          }
          if (current.contextEngineCleanupCompletedAt !== undefined) {
            return { value: undefined };
          }
          return {
            value: undefined,
            postimages: new Map([
              [runId, { ...current, contextEngineCleanupCompletedAt: Date.now() }],
            ]),
          };
        },
        {
          context: stateContext,
          assertCurrent,
        },
      );
    }
    return internalEffectsRemoved && attachmentsRemoved && contextEnded && isCurrent();
  }

  function shouldEmitEndedHookForRun(params: {
    entry: SubagentRunRecord;
    reason: SubagentLifecycleEndedReason;
  }) {
    return params.reason === SUBAGENT_ENDED_REASON_KILLED || params.entry.spawnMode !== "session";
  }

  async function emitSubagentEndedHookForRun(params: {
    entry: SubagentRunRecord;
    reason?: SubagentLifecycleEndedReason;
    sendFarewell?: boolean;
    accountId?: string;
    isCurrent?: () => boolean;
    prepareCurrent?: () => Promise<boolean>;
  }) {
    let entry = params.entry;
    const identity = getSubagentRunRuntimeKey(entry);
    if (entry.endedHookEmittedAt || endedHookEmittedOwners.has(identity)) {
      return;
    }
    // Loading and entering plugin scope are part of the best-effort hook boundary.
    try {
      const stateContext = captureOpenClawStateWorkerContext();
      const generation = params.entry.generation;
      const assertCurrent = () => {
        assertSubagentRegistryWriteSourceCurrent(stateContext);
        const current = getCurrentSubagentRunOwner(subagentRuns, params.entry);
        assertSubagentRegistryWriteOutcomeKnown(
          [current?.runId ?? entry.runId],
          stateContext.admission,
        );
        if (
          params.entry.generation !== generation ||
          !config.isEndedHookOwnerCurrent(params.entry.runId, params.entry) ||
          params.isCurrent?.() === false
        ) {
          throw new Error("Subagent ended hook lost its original owner");
        }
        if (!current && subagentRuns.has(entry.runId)) {
          throw new Error("Subagent ended hook lost its original runtime owner");
        }
        if (current) {
          entry = current;
        }
      };
      assertCurrent();
      const cfg = getRuntimeConfig();
      const registry = await loadSubagentRegistryPluginRuntimeHandle({
        config: cfg,
        ...(params.entry.workspaceDir ? { workspaceDir: params.entry.workspaceDir } : {}),
        allowGatewaySubagentBinding: true,
      });
      await withPluginRuntimeRegistryScope(registry, async () => {
        if (
          (await params.prepareCurrent?.()) === false ||
          entry.endedHookEmittedAt ||
          endedHookEmittedOwners.has(identity) ||
          params.isCurrent?.() === false
        ) {
          return;
        }
        assertCurrent();
        // Plugin loading yields after the terminal lock is released. Resolve the
        // event from the canonical row only after that boundary so an older callback
        // cannot claim the exactly-once hook with a superseded timeout or error.
        const reason = entry.endedReason ?? params.reason ?? SUBAGENT_ENDED_REASON_COMPLETE;
        const outcome =
          reason === SUBAGENT_ENDED_REASON_KILLED
            ? SUBAGENT_ENDED_OUTCOME_KILLED
            : resolveLifecycleOutcomeFromRunOutcome(entry.execution.outcome);
        const error =
          entry.execution.outcome?.status === "error" ? entry.execution.outcome.error : undefined;
        await emitSubagentEndedHookOnce({
          entry,
          reason,
          sendFarewell: params.sendFarewell,
          accountId: params.accountId ?? params.entry.requesterOrigin?.accountId,
          outcome,
          error,
          inFlightOwners: endedHookInFlightOwners,
          recordEmitted: async () => {
            endedHookEmittedOwners.add(identity);
            assertCurrent();
            const runId = entry.runId;
            const assertStampCurrent = () => {
              assertCurrent();
              if (entry.runId !== runId) {
                throw new SubagentRegistryMutationRejectedError(
                  "Subagent ended hook address changed before persistence.",
                );
              }
            };
            await mutateSubagentRuns(
              [runId],
              (rows) => {
                assertStampCurrent();
                const current = rows.get(runId);
                // Bookkeeping can retire this execution before its best-effort hook runs.
                if (!current) {
                  return { value: undefined };
                }
                if (!isSameSubagentRunOwner(current, entry)) {
                  throw new SubagentRegistryMutationRejectedError(
                    "Subagent ended hook execution changed.",
                  );
                }
                return {
                  value: undefined,
                  postimages: new Map([[runId, { ...current, endedHookEmittedAt: Date.now() }]]),
                };
              },
              { context: stateContext, assertCurrent: assertStampCurrent },
            );
          },
        });
      });
    } catch (err) {
      if (hasSqliteWorkerOutcomeUnknown(err)) {
        throw err;
      }
      warn("subagent_ended hook failed (best-effort)", { phase: "plugin-runtime", err });
    }
  }

  return {
    runContextEngineSubagentEnded,
    notifyContextEngineSubagentEnded,
    cleanupCollectorLaunchResources,
    suppressAnnounceForSteerRestart: (entry?: SubagentRunRecord) =>
      entry?.suppressAnnounceReason === "steer-restart",
    shouldEmitEndedHookForRun,
    emitSubagentEndedHookForRun,
    reset: () => {
      endedHookInFlightOwners.clear();
    },
  };
}
