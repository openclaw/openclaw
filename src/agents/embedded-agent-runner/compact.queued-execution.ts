import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  loadSessionEntry,
  type SessionTranscriptRuntimeTarget,
} from "../../config/sessions/session-accessor.js";
import { projectPublicSessionEntry } from "../../config/sessions/session-entry-projection.js";
import { withSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { captureIncognitoSessionSource } from "../../config/sessions/session-incognito-binding.js";
import {
  composeSessionSourceAssertion,
  type SessionSourceAssertion,
} from "../../config/sessions/session-source-authority.js";
import {
  withOwnedSessionTranscriptWrites,
  type OwnedSessionTranscriptWriteContext,
} from "../../config/sessions/transcript-write-context.js";
import {
  resolveCompactionSuccessorTranscript,
  type ContextEngine,
  type ContextEngineRuntimeContext,
  type ContextEngineRuntimeSettings,
  type ContextEngineSessionTarget,
} from "../../context-engine/types.js";
import { isAbortError } from "../../infra/abort-signal.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import { enqueueCommandInLane } from "../../process/command-queue.js";
import { normalizeOptionalAgentRuntimeId } from "../agent-runtime-id.js";
import { resolveSessionAgentIds } from "../agent-scope.js";
import { maybeCompactAgentHarnessSession } from "../harness/compaction.js";
import type { AgentHarnessCompactionSourceAuthority } from "../harness/host-source-authority.js";
import type { PreparedModelRuntimeSnapshot } from "../prepared-model-runtime.js";
import type { CompactionRequestConstraints } from "../sessions/compaction/request-budget.js";
import { SessionManager } from "../sessions/index.js";
import { buildCompactionFailureResult } from "./compact-reasons.js";
import type { CompactEmbeddedAgentSessionParams } from "./compact.types.js";
import { runPostCompactionSideEffects } from "./compaction-hooks.js";
import {
  compactContextEngineWithSafetyTimeout,
  resolveCompactionTimeoutMs,
} from "./compaction-safety-timeout.js";
import {
  acceptCompactionSuccessor,
  requireCompactionWriterEntry,
  type AcceptedCompactionSuccessor,
} from "./compaction-successor.js";
import { runContextEngineMaintenance } from "./context-engine-maintenance.js";
import { resolveGlobalLane, resolveSessionLane } from "./lanes.js";
import { log } from "./logger.js";
import { declarePromptHistoryRewrite } from "./prompt-cache-observability.js";
import {
  attachCompactionAccountingRecorder,
  type CompactionAccountingReceipt,
} from "./run/compaction-accounting-bridge.js";
import {
  setTranscriptBytePreflightClaim,
  type TranscriptBytePreflightAuthority,
  type TranscriptByteCompactionPersistence,
  type TranscriptByteCompactionPersistenceAsync,
} from "./transcript-byte-preflight-authority.js";
import type { EmbeddedAgentCompactResult } from "./types.js";

type QueuedCompactionHostCommit = {
  entry: AcceptedCompactionSuccessor["entry"];
  tokensAfter?: number;
  compactionKind: "context-engine" | "server-endpoint";
};

/** Host-only bookkeeping, deliberately separate from plugin compaction parameters. */
export type QueuedCompactionHostOptions = CompactionRequestConstraints & {
  sourceAuthority: AgentHarnessCompactionSourceAuthority;
  assertActive?: SessionSourceAssertion;
  transcriptBytePreflightHarness?: "codex";
  withCompactionPersistence?: TranscriptByteCompactionPersistence;
  withCompactionPersistenceAsync?: TranscriptByteCompactionPersistenceAsync;
  onCommitted?: (accepted: AcceptedCompactionSuccessor) => void;
  onHostCompactionCommitted?: (commit: QueuedCompactionHostCommit) => Promise<void> | void;
  onHostCompactionTranscriptSettled?: (commit: QueuedCompactionHostCommit) => Promise<void> | void;
};

export function createQueuedCompactionAbortedResult(): EmbeddedAgentCompactResult {
  return { ok: false, compacted: false, reason: "compaction aborted" };
}

export async function withQueuedCompactionCancellationResult(
  params: Pick<CompactEmbeddedAgentSessionParams, "abortSignal">,
  run: () => Promise<EmbeddedAgentCompactResult>,
): Promise<EmbeddedAgentCompactResult> {
  try {
    return await run();
  } catch (error) {
    const signal = params.abortSignal;
    if (!signal?.aborted || (!isAbortError(error) && error !== signal.reason)) {
      throw error;
    }
    return createQueuedCompactionAbortedResult();
  }
}

export function projectQueuedCompactionSessionTarget(
  params: CompactEmbeddedAgentSessionParams,
): ContextEngineSessionTarget {
  const agentId = params.sessionTarget?.agentId ?? params.agentId;
  const sessionKey = params.sessionTarget?.sessionKey ?? params.sessionKey;
  const storePath = params.sessionTarget?.storePath;
  return {
    ...(agentId ? { agentId } : {}),
    sessionId: params.sessionTarget?.sessionId ?? params.sessionId,
    ...(sessionKey ? { sessionKey } : {}),
    ...(storePath ? { storePath } : {}),
    ...(params.sessionTarget?.threadId !== undefined
      ? { threadId: params.sessionTarget.threadId }
      : {}),
  };
}

/** Both compaction runtimes cancel pending queue admission before releasing their writer. */
function enqueueCompactionInLanes<T>(
  params: Pick<
    CompactEmbeddedAgentSessionParams,
    "agentId" | "sessionKey" | "sessionId" | "spawnedBy" | "lane" | "enqueue" | "abortSignal"
  >,
  run: () => Promise<T>,
): Promise<T> {
  const sessionLane = resolveSessionLane(params.sessionKey?.trim() || params.sessionId);
  const globalLane = resolveGlobalLane(params.lane, params);
  const enqueueGlobal =
    params.enqueue ?? ((task, opts) => enqueueCommandInLane(globalLane, task, opts));
  const options = {
    abortSignal: params.abortSignal,
    sessionTarget: {
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
    },
  };
  return enqueueCommandInLane(sessionLane, () => enqueueGlobal(run, options), options);
}

export async function runPrimaryNativeCompactionInLanes<T>(
  params: CompactEmbeddedAgentSessionParams & { sessionTarget: SessionTranscriptRuntimeTarget },
  expectedEntry: Parameters<typeof acceptCompactionSuccessor>[0]["expectedEntry"],
  host: QueuedCompactionHostOptions,
  run: () => Promise<T>,
): Promise<T> {
  return await enqueueCompactionInLanes(params, async () => {
    host.assertActive?.();
    await withSessionEntryReadOnlyInWorker(
      { ...params.sessionTarget, readConsistency: "latest" },
      () => host.assertActive?.(),
      async (read) => {
        if (!read.ok) {
          throw read.error;
        }
        requireCompactionWriterEntry(read.value, expectedEntry);
      },
    );
    host.assertActive?.();
    return run();
  });
}

export async function executeQueuedContextEngineCompaction(input: {
  params: CompactEmbeddedAgentSessionParams;
  preparedParams: CompactEmbeddedAgentSessionParams;
  runtimeTarget: SessionTranscriptRuntimeTarget;
  expectedEntry: Parameters<typeof acceptCompactionSuccessor>[0]["expectedEntry"];
  host: QueuedCompactionHostOptions;
  contextEngine: ContextEngine;
  contextEngineSessionKey?: string;
  contextEngineRuntimeContext: ContextEngineRuntimeContext;
  contextEngineRuntimeSettings: ContextEngineRuntimeSettings;
  resolvedWorkspaceDir: string;
  preparedModelRuntime: PreparedModelRuntimeSnapshot;
  effectiveRuntimeModel?: ProviderRuntimeModel;
  preparedHarnessRuntime?: string;
  contextTokenBudget?: number;
  attemptNativeHarnessCompaction: boolean;
  transcriptBytePreflightAuthority?: TranscriptBytePreflightAuthority;
}): Promise<EmbeddedAgentCompactResult> {
  const {
    params,
    preparedParams,
    runtimeTarget,
    expectedEntry,
    host,
    contextEngine,
    contextEngineSessionKey,
    contextEngineRuntimeContext,
    contextEngineRuntimeSettings,
    resolvedWorkspaceDir,
    preparedModelRuntime,
    effectiveRuntimeModel,
    preparedHarnessRuntime,
    contextTokenBudget,
    attemptNativeHarnessCompaction,
    transcriptBytePreflightAuthority,
  } = input;
  const incognito = captureIncognitoSessionSource(runtimeTarget);
  let expected = { ...expectedEntry };
  return await enqueueCompactionInLanes(params, async () => {
    let closed = false;
    const assertCallerActive = composeSessionSourceAssertion(
      [host.assertActive],
      (assertSource) => {
        params.abortSignal?.throwIfAborted();
        if (closed) {
          throw new Error("queued compaction is no longer active");
        }
        assertSource();
      },
    );
    const assertActive = async (target = runtimeTarget, owner = expected) => {
      await withSessionEntryReadOnlyInWorker(
        { ...target, readConsistency: "latest" },
        assertCallerActive,
        async (read) => {
          if (!read.ok) {
            throw read.error;
          }
          requireCompactionWriterEntry(read.value, owner);
        },
      );
    };
    const createTranscriptWriteContext = async (
      target: SessionTranscriptRuntimeTarget,
      owner: typeof expectedEntry,
      signal?: AbortSignal,
    ) => {
      const capturedOwner = { ...owner };
      const sessionTarget = {
        ...target,
        expectedLifecycleRevision: capturedOwner.lifecycleRevision,
        expectedWriterRunId: capturedOwner.activeWriterRunId,
        expectedOwner: {
          lifecycleRevision: capturedOwner.lifecycleRevision,
          activeWriterRunId: capturedOwner.activeWriterRunId,
        },
      };
      const assertCommitAllowed = composeSessionSourceAssertion(
        [assertCallerActive],
        (assertSource) => {
          signal?.throwIfAborted();
          assertSource();
        },
      );
      // The worker rechecks the captured writer fence in its locked transaction;
      // commit admission must only consult live host authority, never host SQLite.
      await assertActive(sessionTarget, capturedOwner);
      assertCommitAllowed();
      return {
        sessionTarget,
        assertCommitAllowed,
        withTranscriptWrite: async (run) => await run(),
      } satisfies OwnedSessionTranscriptWriteContext;
    };
    const canContinue = async () => {
      try {
        await assertActive();
        return true;
      } catch (error) {
        if (params.abortSignal?.aborted || closed) {
          return false;
        }
        throw error;
      }
    };
    try {
      if (params.abortSignal?.aborted) {
        return createQueuedCompactionAbortedResult();
      }
      await assertActive();
      // When the context engine owns compaction, its compact() implementation
      // bypasses compactEmbeddedAgentSessionDirect (which fires the hooks internally).
      // Fire before_compaction / after_compaction hooks here so plugin subscribers
      // are notified regardless of which engine is active.
      const engineOwnsCompaction = contextEngine.info.ownsCompaction === true;
      if (engineOwnsCompaction || contextEngine.info.id !== "legacy") {
        // Plugin compaction and hooks can use the released synchronous transcript reader.
        const { restoreSessionColdTranscript } =
          await import("../../config/sessions/session-cold-storage.js");
        await restoreSessionColdTranscript(runtimeTarget, assertCallerActive);
      }
      await assertActive();
      const hookRunner = engineOwnsCompaction ? getGlobalHookRunner() : null;
      const hookSessionKey = runtimeTarget.sessionKey;
      const { sessionAgentId } = resolveSessionAgentIds({
        sessionKey: params.sessionKey,
        config: params.config,
        agentId: params.agentId,
      });
      const resolvedMessageProvider = params.messageChannel ?? params.messageProvider;
      const hookCtx = {
        sessionId: params.sessionId,
        agentId: sessionAgentId,
        sessionKey: hookSessionKey,
        workspaceDir: resolvedWorkspaceDir,
        messageProvider: resolvedMessageProvider,
      };
      const runHook = async (name: string, run: () => Promise<void>) => {
        try {
          await run();
        } catch (err) {
          log.warn(`${name} hook failed`, { errorMessage: formatErrorMessage(err) });
        }
      };
      const runtimeContext = contextEngineRuntimeContext;
      // Engine-owned compaction doesn't load the transcript at this level, so
      // message counts are unavailable. We pass sessionFile so hook subscribers
      // can read the transcript themselves if they need exact counts.
      if (hookRunner?.hasHooks("before_compaction")) {
        await runHook("before_compaction", () =>
          hookRunner.runBeforeCompaction(
            {
              messageCount: -1,
              sessionFile: params.sessionFile,
            },
            hookCtx,
          ),
        );
      }
      if (params.abortSignal?.aborted) {
        return createQueuedCompactionAbortedResult();
      }
      await assertActive();
      // Every engine gets one host window; the runtime delegate refreshes it per stage.
      // Queued callers keep result-based failures; recovery rejects cancellation.
      let result: Awaited<ReturnType<typeof contextEngine.compact>>;
      let committedCompaction: CompactionAccountingReceipt | undefined;
      try {
        const compactionSessionTarget = projectQueuedCompactionSessionTarget(params);
        const ownedCompactor: Pick<ContextEngine, "compact" | "info"> = {
          info: contextEngine.info,
          compact: async (backendParams) => {
            if (backendParams.runtimeContext) {
              attachCompactionAccountingRecorder(backendParams.runtimeContext, {
                requestBudget: host.requestBudget,
                pendingUserEntryId: host.pendingUserEntryId,
                recordCompaction: (receipt) => {
                  declarePromptHistoryRewrite({ ...runtimeTarget, reason: "compaction" });
                  committedCompaction = receipt;
                },
              });
            }
            // Retained backend work keeps the original owner and the timer's
            // composed signal, never a later accepted successor's authority.
            const writeContext = await createTranscriptWriteContext(
              runtimeTarget,
              expectedEntry,
              backendParams.abortSignal,
            );
            writeContext.assertCommitAllowed();
            const clearClaim = setTranscriptBytePreflightClaim(
              backendParams.runtimeContext,
              transcriptBytePreflightAuthority,
              host.withCompactionPersistence,
              host.withCompactionPersistenceAsync,
            );
            return withOwnedSessionTranscriptWrites(writeContext, () =>
              contextEngine.compact(backendParams),
            ).finally(clearClaim);
          },
        };
        result = await compactContextEngineWithSafetyTimeout(
          ownedCompactor,
          {
            sessionId: params.sessionId,
            sessionKey: hookSessionKey,
            ...(compactionSessionTarget.agentId
              ? { agentId: compactionSessionTarget.agentId }
              : {}),
            sessionTarget: compactionSessionTarget,
            tokenBudget: contextTokenBudget,
            currentTokenCount: params.currentTokenCount,
            compactionTarget: params.trigger === "manual" ? "threshold" : "budget",
            customInstructions: params.customInstructions,
            force:
              params.force === true ||
              params.forcePreflight === true ||
              params.preflightRequired === true ||
              params.trigger === "manual",
            runtimeContext: {
              ...runtimeContext,
              forceReason:
                params.forcePreflight === true || params.preflightRequired === true
                  ? "preflight_required"
                  : params.trigger === "manual"
                    ? "manual"
                    : undefined,
              preflightCompactionTrigger: params.preflightCompactionTrigger,
            },
            runtimeSettings: contextEngineRuntimeSettings,
          },
          resolveCompactionTimeoutMs(params.config),
          params.abortSignal,
        );
      } catch (compactErr) {
        log.warn(
          committedCompaction
            ? "post-compaction work failed after the transcript commit"
            : "context-engine compaction failed",
          { errorMessage: formatErrorMessage(compactErr) },
        );
        result = buildCompactionFailureResult(formatErrorMessage(compactErr));
      }
      if (committedCompaction && (!result.ok || !result.compacted)) {
        // The stock writer committed before a hook or cancellation failed. Retain
        // that fact without adopting successor fields from the failed result.
        result = {
          ok: true,
          compacted: true,
          reason: result.reason,
          result: {
            tokensBefore: committedCompaction.tokensBefore,
            tokensAfter: committedCompaction.tokensAfter,
            details: committedCompaction.details,
          },
        };
      }
      let successor: Pick<
        AcceptedCompactionSuccessor,
        "sessionId" | "sessionFile" | "sessionTarget"
      > &
        Partial<Pick<AcceptedCompactionSuccessor, "entry">> = {
        sessionId: params.sessionId,
        sessionFile: params.sessionFile,
        sessionTarget: runtimeTarget,
      };
      let tokensAfter = result.result?.tokensAfter;
      if (result.ok && result.compacted) {
        const proposed = resolveCompactionSuccessorTranscript(result);
        const target = result.result?.sessionTarget;
        const sameTarget =
          (!proposed.sessionId || proposed.sessionId === runtimeTarget.sessionId) &&
          (!proposed.sessionFile || proposed.sessionFile === params.sessionFile) &&
          (!target?.agentId || target.agentId === runtimeTarget.agentId) &&
          (!target?.sessionKey || target.sessionKey === runtimeTarget.sessionKey) &&
          (!target?.storePath || target.storePath === runtimeTarget.storePath);
        // Completion survives cancellation; a proposed successor's token snapshot
        // belongs to that identity only after the host accepts it.
        tokensAfter = sameTarget ? result.result?.tokensAfter : undefined;
        try {
          successor = await acceptCompactionSuccessor({
            config: params.config,
            currentSessionFile: params.sessionFile,
            currentTarget: runtimeTarget,
            expectedEntry,
            assertActive: assertCallerActive,
            result,
            onCommitted: (accepted) => {
              expected = {
                sessionId: accepted.entry.sessionId,
                lifecycleRevision: accepted.entry.lifecycleRevision,
                activeWriterRunId: accepted.entry.activeWriterRunId,
              };
              host.onCommitted?.(accepted);
            },
          });
          tokensAfter = result.result?.tokensAfter;
          if (!committedCompaction) {
            declarePromptHistoryRewrite({ ...runtimeTarget, reason: "compaction" });
          }
        } catch (error) {
          if (!params.abortSignal?.aborted) {
            throw error;
          }
        }
      }
      const compactionKind: "context-engine" | "server-endpoint" =
        committedCompaction?.compactionKind ??
        (isRecord(result.result?.details) &&
        result.result.details.compactionKind === "server-endpoint" &&
        typeof tokensAfter === "number"
          ? "server-endpoint"
          : "context-engine");
      const hostCommit = successor.entry
        ? { entry: successor.entry, tokensAfter, compactionKind }
        : undefined;
      if (hostCommit) {
        await host.onHostCompactionCommitted?.(hostCommit);
      }
      const postCompactionSessionId = successor.sessionId;
      const postCompactionSessionFile = successor.sessionFile;
      const postCompactionSessionTarget = successor.sessionTarget;
      let secondaryNativeHarnessCompaction: EmbeddedAgentCompactResult | undefined;
      try {
        if (result.ok && result.compacted && (await canContinue()) && contextEngine.maintain) {
          const rewriteContext = await createTranscriptWriteContext(
            postCompactionSessionTarget,
            expected,
            params.abortSignal,
          );
          const sessionManager = await SessionManager.openAsync(
            postCompactionSessionTarget,
            resolvedWorkspaceDir,
            undefined,
            params.abortSignal,
          );
          const maintenance = runContextEngineMaintenance({
            contextEngine,
            sessionId: postCompactionSessionId,
            sessionKey: contextEngineSessionKey ?? params.sessionKey,
            sessionTarget: projectQueuedCompactionSessionTarget({
              ...params,
              sessionFile: postCompactionSessionFile,
              sessionId: postCompactionSessionId,
              sessionTarget: postCompactionSessionTarget,
            }),
            sessionFile: postCompactionSessionFile,
            reason: "compaction",
            sessionManager,
            withSessionManagerRewriteLock: async (operation) =>
              await withOwnedSessionTranscriptWrites(rewriteContext, async () => {
                await assertActive(postCompactionSessionTarget, expected);
                await sessionManager.reloadPersistedTranscriptAsync(params.abortSignal);
                await assertActive(postCompactionSessionTarget, expected);
                return await operation();
              }),
            runtimeContext,
            runtimeSettings: contextEngineRuntimeSettings,
            config: params.config,
            contextEngineAgentId: params.contextEngineAgentId,
            assertActive: rewriteContext.assertCommitAllowed,
            abortSignal: params.abortSignal,
          });
          try {
            await maintenance;
          } finally {
            if (hostCommit) {
              // A rewrite can commit before cancellation is observed. Reconcile transcript
              // state before hooks or native sync; the host callback keeps the writer fence.
              await host.onHostCompactionTranscriptSettled?.(hostCommit);
            }
          }
        }
        if (engineOwnsCompaction && result.ok && result.compacted && (await canContinue())) {
          await runPostCompactionSideEffects({
            config: params.config,
            sessionKey: params.sessionKey,
            sessionId: postCompactionSessionId,
            agentId: sessionAgentId,
            memoryAudience: preparedParams.memoryAudience,
            sandboxed: preparedParams.memorySandboxed,
            sessionFile: postCompactionSessionFile,
            assertActive,
          });
        }
        if (result.ok && (await canContinue()) && hookRunner?.hasHooks("after_compaction")) {
          await runHook("after_compaction", () =>
            hookRunner.runAfterCompaction(
              {
                messageCount: -1,
                compactedCount: result.compacted ? -1 : 0,
                tokenCount: result.result?.tokensAfter,
                sessionFile: postCompactionSessionFile,
                ...(postCompactionSessionId !== params.sessionId
                  ? { previousSessionId: params.sessionId }
                  : {}),
              },
              { ...hookCtx, sessionId: postCompactionSessionId },
            ),
          );
        }
        if (
          (engineOwnsCompaction || transcriptBytePreflightAuthority) &&
          result.ok &&
          result.compacted &&
          (await canContinue()) &&
          attemptNativeHarnessCompaction
        ) {
          try {
            // Committed host compaction stays authoritative; secondary native failure is
            // diagnostic-only in result details and must not trigger a retry.
            // The native bridge owns its terminal-event watchdog. Keep this lane held until
            // that bridge settles; an outer timeout would release transcript ownership while
            // the harness could still be compacting the same session.
            const nativeCompactionOwner = { ...expected };
            secondaryNativeHarnessCompaction = await maybeCompactAgentHarnessSession(
              {
                ...preparedParams,
                sessionId: postCompactionSessionId,
                sessionFile: postCompactionSessionFile,
                sessionTarget: postCompactionSessionTarget,
                ...(successor.entry
                  ? { sessionEntry: projectPublicSessionEntry(successor.entry) }
                  : {}),
                runtimeModel: effectiveRuntimeModel,
                contextEngine,
                contextTokenBudget,
                contextEngineRuntimeContext,
              },
              {
                nativeCompactionRequest: "after_context_engine",
                preparedModelRuntime,
                sourceAuthority: {
                  // Retained native capabilities require a synchronous exact-row authority check.
                  assertActive: () => {
                    assertCallerActive();
                    incognito?.admissionSignal?.throwIfAborted();
                    if (incognito && "kind" in incognito) {
                      incognito.assertCurrent();
                    }
                    requireCompactionWriterEntry(
                      incognito
                        ? "kind" in incognito
                          ? undefined
                          : incognito.actor.sessions.readSharing(
                              postCompactionSessionTarget.sessionKey,
                            )?.entry
                        : loadSessionEntry({
                            ...postCompactionSessionTarget,
                            readConsistency: "latest",
                          }),
                      nativeCompactionOwner,
                    );
                  },
                  operatorAuthority: host.sourceAuthority.operatorAuthority,
                },
              },
            );
            if (secondaryNativeHarnessCompaction && !secondaryNativeHarnessCompaction.ok) {
              log.warn(
                "secondary native harness compaction failed after context-engine compaction",
                {
                  reason: secondaryNativeHarnessCompaction.reason,
                },
              );
            }
          } catch (err) {
            secondaryNativeHarnessCompaction = buildCompactionFailureResult(
              formatErrorMessage(err),
            );
            log.warn("secondary native harness compaction threw after context-engine compaction", {
              errorMessage: formatErrorMessage(err),
            });
          }
        }
      } catch (error) {
        if (await canContinue()) {
          throw error;
        }
        // An abort during maintenance cannot erase the compaction that already completed.
      }
      const secondaryNativeDetailsKey =
        normalizeOptionalAgentRuntimeId(preparedHarnessRuntime) === "codex"
          ? "codexNativeCompaction"
          : "nativeHarnessCompaction";
      let details = result.result?.details;
      if (secondaryNativeHarnessCompaction) {
        details = {
          ...(isRecord(details)
            ? details
            : details === undefined
              ? {}
              : { contextEngine: details }),
          [secondaryNativeDetailsKey]: secondaryNativeHarnessCompaction,
        };
      }
      return {
        ok: result.ok,
        compacted: result.compacted,
        compactionKind,
        reason: result.reason,
        result: result.result
          ? {
              ...(compactionKind === "server-endpoint"
                ? { kind: "server-endpoint" as const }
                : {
                    summary: result.result.summary ?? "",
                    firstKeptEntryId: result.result.firstKeptEntryId ?? "",
                  }),
              tokensBefore: result.result.tokensBefore,
              tokensAfter,
              details,
              ...(postCompactionSessionId !== params.sessionId
                ? { sessionId: postCompactionSessionId }
                : {}),
              ...(postCompactionSessionFile !== params.sessionFile
                ? { sessionFile: postCompactionSessionFile }
                : {}),
            }
          : undefined,
      };
    } finally {
      closed = true;
    }
  });
}
