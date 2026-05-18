import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createInternalHookEvent, triggerInternalHook } from "../../hooks/internal-hooks.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { getActiveMemorySearchManager } from "../../plugins/memory-runtime.js";
import { emitSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import {
  buildPostCompactionMemoryJudgment,
  type PostCompactionMemorySignals,
} from "../agent-compaction-memory-judgment.js";
import {
  buildCompactionTaskSummaryIfPresent,
  type CompactionTaskSummaryExtra,
} from "../agent-compaction-task-summary.js";
import type { MemoryJudgmentResult } from "../agent-memory-judgment.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import type { AgentTaskState } from "../agent-task-state.js";
import { resolveMemorySearchConfig } from "../memory-search.js";
import { log } from "./logger.js";

function resolvePostCompactionIndexSyncMode(config?: OpenClawConfig): "off" | "async" | "await" {
  const mode = config?.agents?.defaults?.compaction?.postIndexSync;
  if (mode === "off" || mode === "async" || mode === "await") {
    return mode;
  }
  return "async";
}

async function runPostCompactionSessionMemorySync(params: {
  config?: OpenClawConfig;
  sessionKey?: string;
  sessionFile: string;
}): Promise<void> {
  if (!params.config) {
    return;
  }
  try {
    const sessionFile = params.sessionFile.trim();
    if (!sessionFile) {
      return;
    }
    const agentId = resolveSessionAgentId({
      sessionKey: params.sessionKey,
      config: params.config,
    });
    const resolvedMemory = resolveMemorySearchConfig(params.config, agentId);
    if (!resolvedMemory || !resolvedMemory.sources.includes("sessions")) {
      return;
    }
    if (!resolvedMemory.sync.sessions.postCompactionForce) {
      return;
    }
    const { manager } = await getActiveMemorySearchManager({
      cfg: params.config,
      agentId,
    });
    if (!manager?.sync) {
      return;
    }
    await manager.sync({
      reason: "post-compaction",
      sessionFiles: [sessionFile],
    });
  } catch (err) {
    log.warn(`memory sync skipped (post-compaction): ${formatErrorMessage(err)}`);
  }
}

function syncPostCompactionSessionMemory(params: {
  config?: OpenClawConfig;
  sessionKey?: string;
  sessionFile: string;
  mode: "off" | "async" | "await";
}): Promise<void> {
  if (params.mode === "off" || !params.config) {
    return Promise.resolve();
  }

  const syncTask = runPostCompactionSessionMemorySync({
    config: params.config,
    sessionKey: params.sessionKey,
    sessionFile: params.sessionFile,
  });
  if (params.mode === "await") {
    return syncTask;
  }
  void syncTask;
  return Promise.resolve();
}

export type PostCompactionSideEffectsResult = {
  /**
   * Memory-write judgment computed from the optional task state and signals.
   * Present only when `params.taskState` was provided; undefined otherwise
   * (backcompat — callers that omit taskState see no behavior change).
   *
   * This is a decision only — no file write occurs here. A future writer
   * path can consume `memoryJudgment.suggested_entry` once a safe, tested
   * writer exists.
   */
  memoryJudgment?: MemoryJudgmentResult;
};

export async function runPostCompactionSideEffects(params: {
  config?: OpenClawConfig;
  sessionKey?: string;
  sessionFile: string;
  /**
   * Optional task state. When present, a memory-write judgment is computed
   * (via `judgeMemoryWrite`) and returned in the result. Existing callers
   * that omit this field are unaffected — they receive an empty result object.
   */
  taskState?: AgentTaskState;
  /**
   * Optional memory signals to pass into the judgment. Only meaningful when
   * `taskState` is also provided.
   */
  memorySignals?: PostCompactionMemorySignals;
}): Promise<PostCompactionSideEffectsResult> {
  const sessionFile = params.sessionFile.trim();
  if (!sessionFile) {
    return {};
  }
  emitSessionTranscriptUpdate({ sessionFile, sessionKey: params.sessionKey });
  await syncPostCompactionSessionMemory({
    config: params.config,
    sessionKey: params.sessionKey,
    sessionFile,
    mode: resolvePostCompactionIndexSyncMode(params.config),
  });

  // Phase 7: compute memory-write judgment when task state is available.
  // Does NOT write to any file — returns the decision for callers to act on.
  const memoryJudgment = buildPostCompactionMemoryJudgment({
    taskState: params.taskState,
    signals: params.memorySignals,
  });

  if (memoryJudgment !== undefined) {
    return { memoryJudgment };
  }
  return {};
}

export type CompactionHookRunner = {
  hasHooks?: (hookName?: string) => boolean;
  runBeforeCompaction?: (
    metrics: { messageCount: number; tokenCount?: number; sessionFile?: string },
    context: {
      sessionId: string;
      agentId: string;
      sessionKey: string;
      workspaceDir: string;
      messageProvider?: string;
    },
  ) => Promise<void> | void;
  runAfterCompaction?: (
    metrics: {
      messageCount: number;
      tokenCount?: number;
      compactedCount: number;
      sessionFile: string;
    },
    context: {
      sessionId: string;
      agentId: string;
      sessionKey: string;
      workspaceDir: string;
      messageProvider?: string;
    },
  ) => Promise<void> | void;
};

export function asCompactionHookRunner(
  hookRunner: ReturnType<typeof getGlobalHookRunner> | null | undefined,
): CompactionHookRunner | null {
  if (!hookRunner) {
    return null;
  }
  return {
    hasHooks: (hookName?: string) => hookRunner.hasHooks?.(hookName as never) ?? false,
    runBeforeCompaction: hookRunner.runBeforeCompaction?.bind(hookRunner),
    runAfterCompaction: hookRunner.runAfterCompaction?.bind(hookRunner),
  };
}

function estimateTokenCountSafe(
  messages: AgentMessage[],
  estimateTokensFn: (message: AgentMessage) => number,
): number | undefined {
  try {
    let total = 0;
    for (const message of messages) {
      total += estimateTokensFn(message);
    }
    return total;
  } catch {
    return undefined;
  }
}

export function buildBeforeCompactionHookMetrics(params: {
  originalMessages: AgentMessage[];
  currentMessages: AgentMessage[];
  observedTokenCount?: number;
  estimateTokensFn: (message: AgentMessage) => number;
}) {
  return {
    messageCountOriginal: params.originalMessages.length,
    tokenCountOriginal: estimateTokenCountSafe(params.originalMessages, params.estimateTokensFn),
    messageCountBefore: params.currentMessages.length,
    tokenCountBefore:
      params.observedTokenCount ??
      estimateTokenCountSafe(params.currentMessages, params.estimateTokensFn),
  };
}

export async function runBeforeCompactionHooks(params: {
  hookRunner?: CompactionHookRunner | null;
  sessionId: string;
  sessionKey?: string;
  sessionAgentId: string;
  workspaceDir: string;
  messageProvider?: string;
  metrics: ReturnType<typeof buildBeforeCompactionHookMetrics>;
  onHookMessages?: (payload: {
    phase: "before";
    messages: string[];
    sessionId: string;
    sessionKey: string;
  }) => void | Promise<void>;
}) {
  const missingSessionKey = !params.sessionKey || !params.sessionKey.trim();
  const hookSessionKey = params.sessionKey?.trim() || params.sessionId;
  try {
    const hookEvent = createInternalHookEvent("session", "compact:before", hookSessionKey, {
      sessionId: params.sessionId,
      missingSessionKey,
      messageCount: params.metrics.messageCountBefore,
      tokenCount: params.metrics.tokenCountBefore,
      messageCountOriginal: params.metrics.messageCountOriginal,
      tokenCountOriginal: params.metrics.tokenCountOriginal,
    });
    await triggerInternalHook(hookEvent);
    if (hookEvent.messages.length > 0) {
      await params.onHookMessages?.({
        phase: "before",
        messages: hookEvent.messages.slice(),
        sessionId: params.sessionId,
        sessionKey: hookSessionKey,
      });
    }
  } catch (err) {
    log.warn("session:compact:before hook failed", {
      errorMessage: formatErrorMessage(err),
      errorStack: err instanceof Error ? err.stack : undefined,
    });
  }
  if (params.hookRunner?.hasHooks?.("before_compaction")) {
    try {
      await params.hookRunner.runBeforeCompaction?.(
        {
          messageCount: params.metrics.messageCountBefore,
          tokenCount: params.metrics.tokenCountBefore,
        },
        {
          sessionId: params.sessionId,
          agentId: params.sessionAgentId,
          sessionKey: hookSessionKey,
          workspaceDir: params.workspaceDir,
          messageProvider: params.messageProvider,
        },
      );
    } catch (err) {
      log.warn("before_compaction hook failed", {
        errorMessage: formatErrorMessage(err),
        errorStack: err instanceof Error ? err.stack : undefined,
      });
    }
  }
  return {
    hookSessionKey,
    missingSessionKey,
  };
}

export function estimateTokensAfterCompaction(params: {
  messagesAfter: AgentMessage[];
  observedTokenCount?: number;
  fullSessionTokensBefore: number;
  estimateTokensFn: (message: AgentMessage) => number;
}) {
  const tokensAfter = estimateTokenCountSafe(params.messagesAfter, params.estimateTokensFn);
  if (tokensAfter === undefined) {
    return undefined;
  }
  const sanityCheckBaseline = params.observedTokenCount ?? params.fullSessionTokensBefore;
  if (
    sanityCheckBaseline > 0 &&
    tokensAfter >
      (params.observedTokenCount !== undefined ? sanityCheckBaseline : sanityCheckBaseline * 1.1)
  ) {
    return undefined;
  }
  return tokensAfter;
}

export type AfterCompactionHooksResult = {
  /**
   * Formatted continuation-prompt text built from the optional task state.
   * Present only when `params.taskState` was provided and the build succeeded.
   * Callers may include this in custom instructions or append it to the
   * compacted session to help the model resume without context loss.
   */
  compactionTaskSummary?: string;
};

export async function runAfterCompactionHooks(params: {
  hookRunner?: CompactionHookRunner | null;
  sessionId: string;
  sessionAgentId: string;
  hookSessionKey: string;
  missingSessionKey: boolean;
  workspaceDir: string;
  messageProvider?: string;
  messageCountAfter: number;
  tokensAfter?: number;
  compactedCount: number;
  sessionFile: string;
  summaryLength?: number;
  tokensBefore?: number;
  firstKeptEntryId?: string;
  /**
   * Optional task state. When present, a structured compaction summary is
   * built before the hooks fire and included in the hook event payload.
   * Existing callers that omit this field are unaffected.
   */
  taskState?: AgentTaskState;
  /**
   * Optional extra metadata to merge into the task summary (tools called,
   * key findings, next step override, user constraints).
   */
  taskSummaryExtra?: CompactionTaskSummaryExtra;
  onHookMessages?: (payload: {
    phase: "after";
    messages: string[];
    sessionId: string;
    sessionKey: string;
  }) => void | Promise<void>;
}): Promise<AfterCompactionHooksResult> {
  // Phase 6: build task summary before hooks fire so plugin consumers can
  // read it from the hook event context. Never throws.
  const compactionTaskSummary = buildCompactionTaskSummaryIfPresent(
    params.taskState,
    params.taskSummaryExtra,
  );

  try {
    const hookEvent = createInternalHookEvent("session", "compact:after", params.hookSessionKey, {
      sessionId: params.sessionId,
      missingSessionKey: params.missingSessionKey,
      messageCount: params.messageCountAfter,
      tokenCount: params.tokensAfter,
      compactedCount: params.compactedCount,
      summaryLength: params.summaryLength,
      tokensBefore: params.tokensBefore,
      tokensAfter: params.tokensAfter,
      firstKeptEntryId: params.firstKeptEntryId,
      // Included when task state was provided; undefined otherwise (no payload bloat).
      compactionTaskSummary,
    });
    await triggerInternalHook(hookEvent);
    if (hookEvent.messages.length > 0) {
      await params.onHookMessages?.({
        phase: "after",
        messages: hookEvent.messages.slice(),
        sessionId: params.sessionId,
        sessionKey: params.hookSessionKey,
      });
    }
  } catch (err) {
    log.warn("session:compact:after hook failed", {
      errorMessage: formatErrorMessage(err),
      errorStack: err instanceof Error ? err.stack : undefined,
    });
  }
  if (params.hookRunner?.hasHooks?.("after_compaction")) {
    try {
      await params.hookRunner.runAfterCompaction?.(
        {
          messageCount: params.messageCountAfter,
          tokenCount: params.tokensAfter,
          compactedCount: params.compactedCount,
          sessionFile: params.sessionFile,
        },
        {
          sessionId: params.sessionId,
          agentId: params.sessionAgentId,
          sessionKey: params.hookSessionKey,
          workspaceDir: params.workspaceDir,
          messageProvider: params.messageProvider,
        },
      );
    } catch (err) {
      log.warn("after_compaction hook failed", {
        errorMessage: formatErrorMessage(err),
        errorStack: err instanceof Error ? err.stack : undefined,
      });
    }
  }

  return { compactionTaskSummary };
}
