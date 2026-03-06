import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { SessionManager } from "@mariozechner/pi-coding-agent";
import type {
  PluginHookBeforeMessageWriteEvent,
  PluginHookBeforeMessageWriteResult,
} from "../plugins/types.js";
import { emitSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import {
  HARD_MAX_TOOL_RESULT_CHARS,
  truncateToolResultMessage,
} from "./pi-embedded-runner/tool-result-truncation.js";
import { createPendingToolCallState } from "./session-tool-result-state.js";
import { makeMissingToolResult, sanitizeToolCallInputs } from "./session-transcript-repair.js";
import { extractToolCallsFromAssistant, extractToolResultId } from "./tool-call-id.js";

const GUARD_TRUNCATION_SUFFIX =
  "\n\n⚠️ [Content truncated during persistence — original exceeded size limit. " +
  "Use offset/limit parameters or request specific sections for large content.]";

type PendingToolCallRecord = { id: string; name?: string; createdAtMs: number };

type PendingToolCallFile = {
  version: 1;
  updatedAtMs: number;
  items: PendingToolCallRecord[];
};

/**
 * Truncate oversized text content blocks in a tool result message.
 * Returns the original message if under the limit, or a new message with
 * truncated text blocks otherwise.
 */
function capToolResultSize(msg: AgentMessage): AgentMessage {
  if ((msg as { role?: string }).role !== "toolResult") {
    return msg;
  }
  return truncateToolResultMessage(msg, HARD_MAX_TOOL_RESULT_CHARS, {
    suffix: GUARD_TRUNCATION_SUFFIX,
    minKeepChars: 2_000,
  });
}

function trimNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizePersistedToolResultName(
  message: AgentMessage,
  fallbackName?: string,
): AgentMessage {
  if ((message as { role?: unknown }).role !== "toolResult") {
    return message;
  }
  const toolResult = message as Extract<AgentMessage, { role: "toolResult" }>;
  const rawToolName = (toolResult as { toolName?: unknown }).toolName;
  const normalizedToolName = trimNonEmptyString(rawToolName);
  if (normalizedToolName) {
    if (rawToolName === normalizedToolName) {
      return toolResult;
    }
    return { ...toolResult, toolName: normalizedToolName };
  }

  const normalizedFallback = trimNonEmptyString(fallbackName);
  if (normalizedFallback) {
    return { ...toolResult, toolName: normalizedFallback };
  }

  if (typeof rawToolName === "string") {
    return { ...toolResult, toolName: "unknown" };
  }
  return toolResult;
}

export function installSessionToolResultGuard(
  sessionManager: SessionManager,
  opts?: {
    /**
     * Grace window (ms) before inserting synthetic tool results for pending
     * tool calls.  Prevents premature synthetic inserts during restart or
     * long-poll ordering jitter.  Defaults to 30 000 ms (30 s).
     */
    pendingToolResultGraceMs?: number;
    /**
     * Optional transform applied to any message before persistence.
     */
    transformMessageForPersistence?: (message: AgentMessage) => AgentMessage;
    /**
     * Optional, synchronous transform applied to toolResult messages *before* they are
     * persisted to the session transcript.
     */
    transformToolResultForPersistence?: (
      message: AgentMessage,
      meta: { toolCallId?: string; toolName?: string; isSynthetic?: boolean },
    ) => AgentMessage;
    /**
     * Whether to synthesize missing tool results to satisfy strict providers.
     * Defaults to true.
     */
    allowSyntheticToolResults?: boolean;
    /**
     * Optional set/list of tool names accepted for assistant toolCall/toolUse blocks.
     * When set, tool calls with unknown names are dropped before persistence.
     */
    allowedToolNames?: Iterable<string>;
    /**
     * Synchronous hook invoked before any message is written to the session JSONL.
     * If the hook returns { block: true }, the message is silently dropped.
     * If it returns { message }, the modified message is written instead.
     */
    beforeMessageWriteHook?: (
      event: PluginHookBeforeMessageWriteEvent,
    ) => PluginHookBeforeMessageWriteResult | undefined;
  },
): {
  flushPendingToolResults: () => void;
  clearPendingToolResults: () => void;
  getPendingIds: () => string[];
} {
  const originalAppend = sessionManager.appendMessage.bind(sessionManager);
  const pendingState = createPendingToolCallState();

  // ---------------------------------------------------------------------------
  // Pending tool-call persistence across restarts
  // ---------------------------------------------------------------------------
  const sessionFile = (
    sessionManager as { getSessionFile?: () => string | null }
  ).getSessionFile?.();
  const pendingFile = sessionFile ? `${sessionFile}.pending-tool-calls.json` : null;

  const loadPendingState = () => {
    if (!pendingFile) {
      return;
    }
    try {
      const raw = readFileSync(pendingFile, "utf8");
      const parsed = JSON.parse(raw) as PendingToolCallFile;
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.items)) {
        return;
      }
      pendingState.restore(parsed.items);
    } catch {
      // File may not exist or be corrupt — best-effort only.
    }
  };

  const savePendingState = () => {
    if (!pendingFile) {
      return;
    }
    const items = pendingState.snapshot();
    try {
      if (items.length === 0) {
        rmSync(pendingFile, { force: true });
        return;
      }
      mkdirSync(dirname(pendingFile), { recursive: true });
      const payload: PendingToolCallFile = {
        version: 1,
        updatedAtMs: Date.now(),
        items,
      };
      writeFileSync(pendingFile, `${JSON.stringify(payload)}\n`, "utf8");
    } catch {
      // Best-effort only — do not crash the gateway for persistence failures.
    }
  };

  // Restore any pending tool calls that survived a gateway restart.
  loadPendingState();

  const persistMessage = (message: AgentMessage) => {
    const transformer = opts?.transformMessageForPersistence;
    return transformer ? transformer(message) : message;
  };

  const persistToolResult = (
    message: AgentMessage,
    meta: { toolCallId?: string; toolName?: string; isSynthetic?: boolean },
  ) => {
    const transformer = opts?.transformToolResultForPersistence;
    return transformer ? transformer(message, meta) : message;
  };

  const allowSyntheticToolResults = opts?.allowSyntheticToolResults ?? true;
  const beforeWrite = opts?.beforeMessageWriteHook;
  const pendingToolResultGraceMs = Math.max(0, opts?.pendingToolResultGraceMs ?? 30_000);

  /**
   * Run the before_message_write hook. Returns the (possibly modified) message,
   * or null if the message should be blocked.
   */
  const applyBeforeWriteHook = (msg: AgentMessage): AgentMessage | null => {
    if (!beforeWrite) {
      return msg;
    }
    const result = beforeWrite({ message: msg });
    if (result?.block) {
      return null;
    }
    if (result?.message) {
      return result.message;
    }
    return msg;
  };

  const flushPendingToolResults = (
    reason:
      | "ttl_expired"
      | "sanitized_drop"
      | "new_tool_calls"
      | "explicit_finalize" = "explicit_finalize",
    ids?: string[],
    nowMs?: number,
  ) => {
    const ts = nowMs ?? Date.now();
    if (pendingState.size() === 0) {
      return;
    }

    const isSelectiveFlush = ids != null && ids.length > 0;
    const targetIds = isSelectiveFlush ? ids : pendingState.getPendingIds();
    if (allowSyntheticToolResults) {
      for (const id of targetIds) {
        const name = pendingState.getToolName(id);
        const createdAtMs = pendingState.getCreatedAtMs(id);
        const ageMs = typeof createdAtMs === "number" ? ts - createdAtMs : undefined;
        const synthetic = makeMissingToolResult({ toolCallId: id, toolName: name });
        const flushed = applyBeforeWriteHook(
          persistToolResult(persistMessage(synthetic), {
            toolCallId: id,
            toolName: name,
            isSynthetic: true,
          }),
        );
        if (flushed) {
          originalAppend(flushed as never);
        }
        // Structured telemetry for every synthetic insertion path.
        const blocked = !flushed;
        console.warn(
          JSON.stringify({
            subsystem: "agents/transcript-guard",
            event: "synthetic_tool_result_attempted",
            reason,
            toolCallId: id,
            toolName: name,
            ageMs,
            blocked,
          }),
        );
        pendingState.delete(id);
      }
    } else {
      for (const id of targetIds) {
        pendingState.delete(id);
      }
    }
    // Only clear remaining entries when doing a full flush (no specific ids targeted).
    // For selective flushes (e.g., ttl_expired with only expired IDs), non-expired
    // entries must remain pending so they can still receive real results or be flushed
    // once their own grace window expires.
    if (!isSelectiveFlush) {
      pendingState.clear();
    }
    savePendingState();
  };

  const clearPendingToolResults = () => {
    pendingState.clear();
    savePendingState();
  };

  const guardedAppend = (message: AgentMessage) => {
    let nextMessage = message;
    const role = (message as { role?: unknown }).role;
    if (role === "assistant") {
      const sanitized = sanitizeToolCallInputs([message], {
        allowedToolNames: opts?.allowedToolNames,
      });
      if (sanitized.length === 0) {
        if (pendingState.shouldFlushForSanitizedDrop()) {
          flushPendingToolResults("sanitized_drop");
        }
        return undefined;
      }
      nextMessage = sanitized[0];
    }
    const nextRole = (nextMessage as { role?: unknown }).role;

    if (nextRole === "toolResult") {
      const id = extractToolResultId(nextMessage as Extract<AgentMessage, { role: "toolResult" }>);
      const toolName = id ? pendingState.getToolName(id) : undefined;
      if (id) {
        pendingState.delete(id);
        savePendingState();
      }
      const normalizedToolResult = normalizePersistedToolResultName(nextMessage, toolName);
      // Apply hard size cap before persistence to prevent oversized tool results
      // from consuming the entire context window on subsequent LLM calls.
      const capped = capToolResultSize(persistMessage(normalizedToolResult));
      const persisted = applyBeforeWriteHook(
        persistToolResult(capped, {
          toolCallId: id ?? undefined,
          toolName,
          isSynthetic: false,
        }),
      );
      if (!persisted) {
        return undefined;
      }
      return originalAppend(persisted as never);
    }

    // Skip tool call extraction for aborted/errored assistant messages.
    // When stopReason is "error" or "aborted", the tool_use blocks may be incomplete
    // and should not have synthetic tool_results created. Creating synthetic results
    // for incomplete tool calls causes API 400 errors:
    // "unexpected tool_use_id found in tool_result blocks"
    // This matches the behavior in repairToolUseResultPairing (session-transcript-repair.ts)
    const stopReason = (nextMessage as { stopReason?: string }).stopReason;
    const toolCalls =
      nextRole === "assistant" && stopReason !== "aborted" && stopReason !== "error"
        ? extractToolCallsFromAssistant(nextMessage as Extract<AgentMessage, { role: "assistant" }>)
        : [];

    // Always clear pending tool call state before appending non-tool-result messages.
    // flushPendingToolResults() only inserts synthetic results when allowSyntheticToolResults
    // is true; for full (non-selective) flushes it clears the entire pending map, while
    // selective flushes only remove the specified IDs.  Without this, providers that
    // disable synthetic results (e.g. OpenAI) accumulate stale pending state when a user
    // message interrupts in-flight tool calls, leaving orphaned tool_use blocks in the transcript
    // that cause API 400 errors on subsequent requests.
    //
    // Grace-window behavior: compute expired IDs once using a single timestamp to
    // avoid redundant iteration and inconsistent Date.now() snapshots.
    //
    // The grace window only applies to intermediate assistant messages (long-poll
    // jitter). Non-assistant messages (user, system, etc.) definitively end the
    // tool-call turn, so all pending entries must be flushed immediately to
    // preserve the required message ordering (assistant → toolResult → user).
    const nowMs = Date.now();
    const isNonToolFlow =
      (toolCalls.length === 0 || nextRole !== "assistant") && pendingState.size() > 0;
    if (isNonToolFlow) {
      const idsToFlush =
        nextRole === "assistant"
          ? pendingState.getExpiredIds(pendingToolResultGraceMs, nowMs)
          : pendingState.getPendingIds();
      if (idsToFlush.length > 0) {
        flushPendingToolResults("ttl_expired", idsToFlush, nowMs);
      }
    }

    // If new tool calls arrive while older ones are pending, flush the old ones first.
    if (pendingState.shouldFlushBeforeNewToolCalls(toolCalls.length)) {
      flushPendingToolResults("new_tool_calls");
    }

    const finalMessage = applyBeforeWriteHook(persistMessage(nextMessage));
    if (!finalMessage) {
      return undefined;
    }
    const result = originalAppend(finalMessage as never);

    const emitSessionFile = (
      sessionManager as { getSessionFile?: () => string | null }
    ).getSessionFile?.();
    if (emitSessionFile) {
      emitSessionTranscriptUpdate(emitSessionFile);
    }

    if (toolCalls.length > 0) {
      pendingState.trackToolCalls(toolCalls);
      savePendingState();
    }

    return result;
  };

  // Monkey-patch appendMessage with our guarded version.
  sessionManager.appendMessage = guardedAppend as SessionManager["appendMessage"];

  return {
    flushPendingToolResults,
    clearPendingToolResults,
    getPendingIds: pendingState.getPendingIds,
  };
}
