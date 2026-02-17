import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { TextContent } from "@mariozechner/pi-ai";
import type { SessionManager } from "@mariozechner/pi-coding-agent";
import { createHash } from "node:crypto";
import type {
  PluginHookBeforeMessageWriteEvent,
  PluginHookBeforeMessageWriteResult,
} from "../plugins/types.js";
import { emitSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { HARD_MAX_TOOL_RESULT_CHARS } from "./pi-embedded-runner/tool-result-truncation.js";
import { makeMissingToolResult, sanitizeToolCallInputs } from "./session-transcript-repair.js";
import { extractToolCallsFromAssistant, extractToolResultId } from "./tool-call-id.js";

const GUARD_TRUNCATION_SUFFIX =
  "\n\n⚠️ [Content truncated during persistence — original exceeded size limit. " +
  "Use offset/limit parameters or request specific sections for large content.]";

// Session transcripts should be resilient across providers. Some OpenAI-compatible APIs
// generate tool call ids like `functions.exec:0` (or include whitespace), which can
// break strict parsers / validators on reload. Normalize ids before persistence and
// apply a stable mapping to corresponding toolResult messages.
const PERSISTED_TOOL_ID_RE = /^[a-zA-Z0-9_-]+$/;

function shortHash(text: string, length = 8): string {
  return createHash("sha1").update(text).digest("hex").slice(0, length);
}

function normalizePersistedToolCallId(raw: string): string {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) {
    return "tool";
  }
  if (PERSISTED_TOOL_ID_RE.test(trimmed)) {
    return trimmed;
  }

  // Keep only safe chars for on-disk transcripts.
  const replaced = trimmed.replace(/[^a-zA-Z0-9_-]/g, "_");
  const collapsed = replaced.replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  return collapsed || `tool_${shortHash(trimmed)}`;
}

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
  flushPendingToolResults: () => void;
  getPendingIds: () => string[];
} {
  const originalAppend = sessionManager.appendMessage.bind(sessionManager);
  const pending = new Map<string, string | undefined>();

  const persistedIdMap = new Map<string, string>();
  const usedPersistedIds = new Set<string>();

  const resolvePersistedId = (id: string): string => {
    const raw = typeof id === "string" ? id : "";
    const canonical = raw.trim();
    if (!canonical) {
      return "tool";
    }

    const existing = persistedIdMap.get(canonical);
    if (existing) {
      return existing;
    }

    // Idempotence: if we've already emitted this id (e.g. a toolResult message
    // has already been mapped once), don't remap it again.
    if (PERSISTED_TOOL_ID_RE.test(canonical) && usedPersistedIds.has(canonical)) {
      return canonical;
    }

    const base = normalizePersistedToolCallId(canonical);
    if (!usedPersistedIds.has(base)) {
      persistedIdMap.set(canonical, base);
      usedPersistedIds.add(base);
      return base;
    }

    const candidate = `${base}_${shortHash(canonical)}`;
    if (!usedPersistedIds.has(candidate)) {
      persistedIdMap.set(canonical, candidate);
      usedPersistedIds.add(candidate);
      return candidate;
    }

    for (let i = 2; i < 1000; i += 1) {
      const next = `${base}_${i}`;
      if (!usedPersistedIds.has(next)) {
        persistedIdMap.set(canonical, next);
        usedPersistedIds.add(next);
        return next;
      }
    }

    const fallback = `tool_${shortHash(`${canonical}:${Date.now()}`)}`;
    persistedIdMap.set(canonical, fallback);
    usedPersistedIds.add(fallback);
    return fallback;
  };

  const applyPersistedIdMapping = (message: AgentMessage): AgentMessage => {
    if (!message || typeof message !== "object") {
      return message;
    }

    const role = (message as { role?: unknown }).role;

    if (role === "assistant") {
      const content = (message as { content?: unknown }).content;
      if (!Array.isArray(content)) {
        return message;
      }
      let changed = false;
      const nextContent = content.map((block: unknown) => {
        if (!block || typeof block !== "object") {
          return block;
        }
        const rec = block as { type?: unknown; id?: unknown };
        const type = rec.type;
        const id = rec.id;
        if (
          (type !== "functionCall" && type !== "toolUse" && type !== "toolCall") ||
          typeof id !== "string" ||
          !id
        ) {
          return block;
        }
        const nextId = resolvePersistedId(id);
        if (nextId === id) {
          return block;
        }
        changed = true;
        return { ...(block as unknown as Record<string, unknown>), id: nextId };
      });
      return changed
        ? ({
            ...(message as unknown as Record<string, unknown>),
            content: nextContent,
          } as AgentMessage)
        : message;
    }

    if (role === "toolResult") {
      const toolCallId = (message as { toolCallId?: unknown }).toolCallId;
      const toolUseId = (message as { toolUseId?: unknown }).toolUseId;
      const toolCallIdStr = typeof toolCallId === "string" && toolCallId ? toolCallId : undefined;
      const toolUseIdStr = typeof toolUseId === "string" && toolUseId ? toolUseId : undefined;
      const nextToolCallId = toolCallIdStr ? resolvePersistedId(toolCallIdStr) : undefined;
      const nextToolUseId = toolUseIdStr ? resolvePersistedId(toolUseIdStr) : undefined;

      if (nextToolCallId === toolCallIdStr && nextToolUseId === toolUseIdStr) {
        return message;
      }

      return {
        ...(message as unknown as Record<string, unknown>),
        ...(nextToolCallId !== undefined ? { toolCallId: nextToolCallId } : null),
        ...(nextToolUseId !== undefined ? { toolUseId: nextToolUseId } : null),
      } as AgentMessage;
    }

    return message;
  };

  const persistMessage = (message: AgentMessage) => {
    const mapped = applyPersistedIdMapping(message);
    const transformer = opts?.transformMessageForPersistence;
    return transformer ? transformer(mapped) : mapped;
  };

  const persistToolResult = (
    message: AgentMessage,
    meta: { toolCallId?: string; toolName?: string; isSynthetic?: boolean },
  ) => {
    // `persistMessage` already applies the persisted tool id mapping; keep this focused
    // on the optional tool-result persistence hook.
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

  const flushPendingToolResults = () => {
    if (pending.size === 0) {
      return;
    }
    if (allowSyntheticToolResults) {
      for (const [id, name] of pending.entries()) {
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
      }
    }
    pending.clear();
  };

  const guardedAppend = (message: AgentMessage) => {
    let nextMessage = message;
    const role = (message as { role?: unknown }).role;
    if (role === "assistant") {
      const sanitized = sanitizeToolCallInputs([message]);
      if (sanitized.length === 0) {
        if (allowSyntheticToolResults && pending.size > 0) {
          flushPendingToolResults();
        }
        return undefined;
      }
      nextMessage = sanitized[0];
    }
    const nextRole = (nextMessage as { role?: unknown }).role;

    if (nextRole === "toolResult") {
      const idRaw = extractToolResultId(
        nextMessage as Extract<AgentMessage, { role: "toolResult" }>,
      );
      const id = idRaw ? resolvePersistedId(idRaw) : null;
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
        return undefined;
      }
      return originalAppend(persisted as never);
    }

    const toolCalls =
      nextRole === "assistant"
        ? extractToolCallsFromAssistant(nextMessage as Extract<AgentMessage, { role: "assistant" }>)
        : [];

    if (allowSyntheticToolResults) {
      // If previous tool calls are still pending, flush before non-tool results.
      if (pending.size > 0 && (toolCalls.length === 0 || nextRole !== "assistant")) {
        flushPendingToolResults();
      }
      // If new tool calls arrive while older ones are pending, flush the old ones first.
      if (pending.size > 0 && toolCalls.length > 0) {
        flushPendingToolResults();
      }
    }

    const finalMessage = applyBeforeWriteHook(persistMessage(nextMessage));
    if (!finalMessage) {
      return undefined;
    }
    const result = originalAppend(finalMessage as never);

    const sessionFile = (
      sessionManager as { getSessionFile?: () => string | null }
    ).getSessionFile?.();
    if (sessionFile) {
      emitSessionTranscriptUpdate(sessionFile);
    }

    if (toolCalls.length > 0) {
      for (const call of toolCalls) {
        pending.set(resolvePersistedId(call.id), call.name);
      }
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
