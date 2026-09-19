/**
 * Adapts prepared compaction runtime state to the shared after-compaction hook boundary.
 */
import {
  asCompactionHookRunner,
  runAfterCompactionHooks,
  runBeforeCompactionHooks,
} from "./compaction-hooks.js";
import type { PreparedCompactionRuntime } from "./prepared-compaction-runtime.js";

type PreparedAfterCompactionHookParams = {
  runtime: PreparedCompactionRuntime;
  hookRunner: ReturnType<typeof asCompactionHookRunner>;
  hookState: Awaited<ReturnType<typeof runBeforeCompactionHooks>>;
  messageCountAfter: number;
  tokensAfter?: number;
  compactedCount: number;
  /** Internal-hook only: native skip completion, distinct from compactedCount 0 after a rewrite. */
  compactionOutcome?: "skipped";
  sessionFile: string;
  summaryLength?: number;
  tokensBefore?: number;
  firstKeptEntryId?: string;
  assertActive: () => void;
};

export async function runPreparedAfterCompactionHooks(
  params: PreparedAfterCompactionHookParams,
): Promise<void> {
  const { runtime } = params;
  await runAfterCompactionHooks({
    hookRunner: params.hookRunner,
    sessionId: runtime.params.sessionId,
    sessionAgentId: runtime.sessionAgentId,
    hookSessionKey: params.hookState.hookSessionKey,
    missingSessionKey: params.hookState.missingSessionKey,
    workspaceDir: runtime.effectiveWorkspace,
    messageProvider: runtime.resolvedMessageProvider,
    messageCountAfter: params.messageCountAfter,
    tokensAfter: params.tokensAfter,
    compactedCount: params.compactedCount,
    ...(params.compactionOutcome ? { compactionOutcome: params.compactionOutcome } : {}),
    sessionFile: params.sessionFile,
    summaryLength: params.summaryLength,
    tokensBefore: params.tokensBefore,
    firstKeptEntryId: params.firstKeptEntryId,
    assertActive: params.assertActive,
    onHookMessages: runtime.params.onCompactionHookMessages,
  });
}

/** Completes a native no-conversation skip with one after_compaction and no rewrite. */
export async function completeNativeSkippedCompaction(params: {
  runtime: PreparedCompactionRuntime;
  hookRunner: ReturnType<typeof asCompactionHookRunner>;
  hookState: Awaited<ReturnType<typeof runBeforeCompactionHooks>>;
  messageCountAfter: number;
  tokensAfter?: number;
  sessionFile: string;
  tokensBefore?: number;
  assertActive: () => void;
}): Promise<{ ok: true; compacted: false; reason: "no real conversation messages" }> {
  await runPreparedAfterCompactionHooks({
    ...params,
    compactedCount: 0,
    compactionOutcome: "skipped",
  });
  return {
    ok: true,
    compacted: false,
    reason: "no real conversation messages",
  };
}
