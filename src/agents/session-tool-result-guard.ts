import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { TextContent } from "@mariozechner/pi-ai";
import type { SessionManager } from "@mariozechner/pi-coding-agent";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type {
  PluginHookBeforeMessageWriteEvent,
  PluginHookBeforeMessageWriteResult,
} from "../plugins/types.js";
import { emitSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { HARD_MAX_TOOL_RESULT_CHARS } from "./pi-embedded-runner/tool-result-truncation.js";
import { makeMissingToolResult, sanitizeToolCallInputs } from "./session-transcript-repair.js";
import { extractToolCallsFromAssistant, extractToolResultId } from "./tool-call-id.js";

const log = createSubsystemLogger("agent/tool-guard");

const GUARD_TRUNCATION_SUFFIX =
  "\n\n⚠️ [Content truncated during persistence — original exceeded size limit. " +
  "Use offset/limit parameters or request specific sections for large content.]";

/**
 * Truncate oversized text content blocks in a tool result message.
 * Returns the original message if under the limit, or a new message with
 * truncated text blocks otherwise.
 */
function capToolResultSize(msg: AgentMessage): AgentMessage {
  const role = (msg as { role?: string }).role;
  if (role !== "toolResult") {
    return msg;
  }
  const content = (msg as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return msg;
  }

  // Calculate total text size
  let totalTextChars = 0;
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
      const text = (block as TextContent).text;
      if (typeof text === "string") {
        totalTextChars += text.length;
      }
    }
  }

  if (totalTextChars <= HARD_MAX_TOOL_RESULT_CHARS) {
    return msg;
  }

  // Truncate proportionally
  const newContent = content.map((block: unknown) => {
    if (!block || typeof block !== "object" || (block as { type?: string }).type !== "text") {
      return block;
    }
    const textBlock = block as TextContent;
    if (typeof textBlock.text !== "string") {
      return block;
    }
    const blockShare = textBlock.text.length / totalTextChars;
    const blockBudget = Math.max(
      2_000,
      Math.floor(HARD_MAX_TOOL_RESULT_CHARS * blockShare) - GUARD_TRUNCATION_SUFFIX.length,
    );
    if (textBlock.text.length <= blockBudget) {
      return block;
    }
    // Try to cut at a newline boundary
    let cutPoint = blockBudget;
    const lastNewline = textBlock.text.lastIndexOf("\n", blockBudget);
    if (lastNewline > blockBudget * 0.8) {
      cutPoint = lastNewline;
    }
    return {
      ...textBlock,
      text: textBlock.text.slice(0, cutPoint) + GUARD_TRUNCATION_SUFFIX,
    };
  });

  return { ...msg, content: newContent } as AgentMessage;
}

export function installSessionToolResultGuard(
  sessionManager: SessionManager,
  opts?: {
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
     * Synchronous hook invoked before any message is written to the session JSONL.
     * If the hook returns { block: true }, the message is silently dropped.
     * If it returns { message }, the modified message is written instead.
     */
    beforeMessageWriteHook?: (
      event: PluginHookBeforeMessageWriteEvent,
    ) => PluginHookBeforeMessageWriteResult | undefined;
  },
): {
  /**
   * Flush any pending tool results.
   *
   * Default mode (OPENCLAW_TOOL_GUARD_ABORT_MODE=discard): discards the
   * incomplete pair buffer without writing to JSONL.
   * Legacy mode (OPENCLAW_TOOL_GUARD_ABORT_MODE=synthetic): synthesizes
   * error tool_results for any pending tool_use IDs.
   *
   * Idempotent: no-op when nothing is buffered.
   *
   * @param reason - Optional label used in log output (e.g. "abort", "failover", "rate_limit").
   */
  flushPendingToolResults: (reason?: string) => void;
  getPendingIds: () => string[];
} {
  const originalAppend = sessionManager.appendMessage.bind(sessionManager);
  const pending = new Map<string, string | undefined>();
  const toolPairBuffer: AgentMessage[] = [];

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

  // Read env var to determine abort behavior
  const resolveAbortMode = (): "discard" | "synthetic" => {
    return process.env.OPENCLAW_TOOL_GUARD_ABORT_MODE === "synthetic" ? "synthetic" : "discard";
  };

  // Validate that all tool_use in buffer have matching tool_results
  const validatePairIntegrity = (): boolean => {
    const usedIds = new Set<string>();
    const resultIds = new Set<string>();
    for (const msg of toolPairBuffer) {
      const role = (msg as { role?: unknown }).role;
      if (role === "assistant") {
        const calls = extractToolCallsFromAssistant(
          msg as Extract<AgentMessage, { role: "assistant" }>,
        );
        for (const c of calls) {
          usedIds.add(c.id);
        }
      } else if (role === "toolResult") {
        const id = extractToolResultId(msg as Extract<AgentMessage, { role: "toolResult" }>);
        if (id) {
          resultIds.add(id);
        }
      }
    }
    for (const id of usedIds) {
      if (!resultIds.has(id)) {
        return false;
      }
    }
    for (const id of resultIds) {
      if (!usedIds.has(id)) {
        return false;
      }
    }
    return true;
  };

  // Commit: write buffered messages atomically to JSONL
  const commitToolPairBuffer = () => {
    if (toolPairBuffer.length === 0) {
      return;
    }
    if (!validatePairIntegrity()) {
      log.warn("tool-pair integrity check failed at commit time, discarding buffer");
      toolPairBuffer.length = 0;
      pending.clear();
      return;
    }
    for (const msg of toolPairBuffer) {
      originalAppend(msg as never);
      if ((msg as { role?: unknown }).role === "assistant") {
        const sessionFile = (
          sessionManager as { getSessionFile?: () => string | null }
        ).getSessionFile?.();
        if (sessionFile) {
          emitSessionTranscriptUpdate(sessionFile);
        }
      }
    }
    toolPairBuffer.length = 0;
  };

  // Discard: drop buffer and log
  const discardToolPairBuffer = (reason: string) => {
    const discarded_tool_use_count = pending.size;
    const discarded_tool_result_count = toolPairBuffer.filter(
      (m) => (m as { role?: unknown }).role === "toolResult",
    ).length;
    if (discarded_tool_use_count === 0 && discarded_tool_result_count === 0) {
      return;
    }
    log.warn("discarding incomplete tool pair buffer", {
      discard_reason: reason,
      discarded_tool_use_count,
      discarded_tool_result_count,
    });
    toolPairBuffer.length = 0;
    pending.clear();
  };

  const flushPendingToolResults = (reason = "flush") => {
    if (pending.size === 0 && toolPairBuffer.length === 0) {
      return;
    } // idempotent

    if (resolveAbortMode() === "synthetic" && allowSyntheticToolResults) {
      // Legacy: synthesize error results for pending tool calls
      for (const [id, name] of pending.entries()) {
        const synthetic = makeMissingToolResult({ toolCallId: id, toolName: name });
        const prepared = applyBeforeWriteHook(
          persistToolResult(persistMessage(synthetic), {
            toolCallId: id,
            toolName: name,
            isSynthetic: true,
          }),
        );
        if (prepared) {
          toolPairBuffer.push(prepared);
        }
      }
      pending.clear(); // clear pending before commit so validatePairIntegrity passes with synthetics
      commitToolPairBuffer();
    } else {
      discardToolPairBuffer(reason);
    }
  };

  const guardedAppend = (message: AgentMessage) => {
    let nextMessage = message;
    const role = (message as { role?: unknown }).role;
    if (role === "assistant") {
      const sanitized = sanitizeToolCallInputs([message]);
      if (sanitized.length === 0) {
        // Assistant message was dropped (e.g., only had invalid tool calls)
        // Discard any incomplete buffer
        if (toolPairBuffer.length > 0 || pending.size > 0) {
          discardToolPairBuffer("assistant_message_dropped");
        }
        return undefined;
      }
      nextMessage = sanitized[0];
    }
    const nextRole = (nextMessage as { role?: unknown }).role;

    if (nextRole === "toolResult") {
      const id = extractToolResultId(nextMessage as Extract<AgentMessage, { role: "toolResult" }>);
      const toolName = id ? pending.get(id) : undefined;
      if (id) {
        pending.delete(id);
      }
      // Apply hard size cap before persistence to prevent oversized tool results
      // from consuming the entire context window on subsequent LLM calls.
      const capped = capToolResultSize(persistMessage(nextMessage));
      const persisted = applyBeforeWriteHook(
        persistToolResult(capped, {
          toolCallId: id ?? undefined,
          toolName,
          isSynthetic: false,
        }),
      );
      if (!persisted) {
        // Hook suppressed this result. A suppressed result cannot satisfy its
        // tool_use counterpart, so the pair is now incomplete. Discard the
        // buffer to prevent an orphaned tool_use block from reaching JSONL.
        if (pending.size === 0 && toolPairBuffer.length > 0) {
          discardToolPairBuffer("hook_suppressed_tool_result");
        }
        return undefined;
      }

      if (toolPairBuffer.length > 0) {
        // Pair-atomic: add to buffer, commit when pair is complete
        toolPairBuffer.push(persisted);
        if (pending.size === 0) {
          commitToolPairBuffer();
        }
        return undefined;
      }

      // Fallback: no buffer in progress, write directly (edge case)
      return originalAppend(persisted as never);
    }

    const toolCalls =
      nextRole === "assistant"
        ? extractToolCallsFromAssistant(nextMessage as Extract<AgentMessage, { role: "assistant" }>)
        : [];

    // Safety: discard any incomplete pair buffer before a new turn
    if (toolPairBuffer.length > 0 || pending.size > 0) {
      discardToolPairBuffer("new_turn_before_pair_completed");
    }

    const finalMessage = applyBeforeWriteHook(persistMessage(nextMessage));
    if (!finalMessage) {
      return undefined;
    }

    if (toolCalls.length > 0) {
      // Pair-atomic: buffer assistant message with tool_use, don't write yet
      toolPairBuffer.push(finalMessage);
      for (const call of toolCalls) {
        pending.set(call.id, call.name);
      }
      return undefined;
    }

    // No tool calls: write directly
    const result = originalAppend(finalMessage as never);
    const sessionFile = (
      sessionManager as { getSessionFile?: () => string | null }
    ).getSessionFile?.();
    if (sessionFile) {
      emitSessionTranscriptUpdate(sessionFile);
    }
    return result;
  };

  // Monkey-patch appendMessage with our guarded version.
  sessionManager.appendMessage = guardedAppend as SessionManager["appendMessage"];

  return {
    flushPendingToolResults,
    getPendingIds: () => Array.from(pending.keys()),
  };
}
