import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { TextContent } from "@mariozechner/pi-ai";
import type { SessionEntry, SessionManager } from "@mariozechner/pi-coding-agent";
import fs from "node:fs";
import { createRequire } from "node:module";
import type { RedactSensitiveMode } from "../logging/redact.js";
import { redactSensitiveText } from "../logging/redact.js";
import { emitSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { HARD_MAX_TOOL_RESULT_CHARS } from "./pi-embedded-runner/tool-result-truncation.js";
import { makeMissingToolResult, sanitizeToolCallInputs } from "./session-transcript-repair.js";

const requireConfig = createRequire(import.meta.url);

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

/** Redact options resolved once at guard installation time. */
type ResolvedRedactOptions = { mode?: RedactSensitiveMode; patterns?: string[] };

/**
 * Redact text blocks in a content array. Returns `{ changed, content }`.
 * Shared by message entries and custom_message entries to avoid code duplication.
 */
function redactTextBlocks(
  content: unknown[],
  options: ResolvedRedactOptions,
): { changed: boolean; content: unknown[] } {
  let changed = false;
  const newContent = content.map((block: unknown) => {
    if (!block || typeof block !== "object" || (block as { type?: string }).type !== "text") {
      return block;
    }
    const textBlock = block as TextContent;
    if (typeof textBlock.text !== "string" || !textBlock.text) {
      return block;
    }
    const redacted = redactSensitiveText(textBlock.text, options);
    if (redacted === textBlock.text) {
      return block;
    }
    changed = true;
    return { ...textBlock, text: redacted };
  });
  return { changed, content: newContent };
}

/**
 * Redact sensitive secrets from a session entry before writing to disk.
 * Handles three entry shapes:
 * - Message entries (type: "message"): redacts text blocks in `message.content[]`
 * - Summary entries (type: "compaction" / "branch_summary"): redacts the `summary` string
 * - Custom message entries (type: "custom_message"): redacts `content` (string or TextContent[])
 *
 * Returns a shallow clone with redacted fields — the original entry is never mutated.
 * Only `text` properties (strings, immutable) are replaced; other properties
 * share references with the original, which is safe.
 *
 * @param options Pre-resolved redact options (mode + patterns). Resolved once at guard
 *   installation time to avoid calling `loadConfig()` on every text block.
 *
 * @internal Exported for testing and for `openclaw sessions scrub` CLI command.
 */
export function redactEntryForPersistence(
  entry: SessionEntry,
  options?: ResolvedRedactOptions,
): SessionEntry {
  const opts = options ?? {};
  let result = entry;

  // Redact message.content[] text blocks (covers user, assistant, toolResult messages)
  const msg = (entry as { message?: unknown }).message;
  if (msg && typeof msg === "object") {
    const content = (msg as { content?: unknown }).content;
    if (Array.isArray(content)) {
      const { changed, content: newContent } = redactTextBlocks(content, opts);
      if (changed) {
        result = { ...result, message: { ...msg, content: newContent } } as SessionEntry;
      }
    }
  }

  // Redact summary field (covers compaction and branch_summary entries)
  const summary = (result as { summary?: unknown }).summary;
  if (typeof summary === "string" && summary) {
    const redacted = redactSensitiveText(summary, opts);
    if (redacted !== summary) {
      result = { ...result, summary: redacted } as SessionEntry;
    }
  }

  // Redact custom_message content (extensions inject messages into LLM context)
  const entryType = (result as { type?: string }).type;
  if (entryType === "custom_message") {
    const cmContent = (result as { content?: unknown }).content;
    if (typeof cmContent === "string" && cmContent) {
      const redacted = redactSensitiveText(cmContent, opts);
      if (redacted !== cmContent) {
        result = { ...result, content: redacted } as SessionEntry;
      }
    } else if (Array.isArray(cmContent)) {
      const { changed, content: newCmContent } = redactTextBlocks(cmContent, opts);
      if (changed) {
        result = { ...result, content: newCmContent } as SessionEntry;
      }
    }
  }

  return result;
}

type ToolCall = { id: string; name?: string };

function extractAssistantToolCalls(msg: Extract<AgentMessage, { role: "assistant" }>): ToolCall[] {
  const content = msg.content;
  if (!Array.isArray(content)) {
    return [];
  }

  const toolCalls: ToolCall[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const rec = block as { type?: unknown; id?: unknown; name?: unknown };
    if (typeof rec.id !== "string" || !rec.id) {
      continue;
    }
    if (rec.type === "toolCall" || rec.type === "toolUse" || rec.type === "functionCall") {
      toolCalls.push({
        id: rec.id,
        name: typeof rec.name === "string" ? rec.name : undefined,
      });
    }
  }
  return toolCalls;
}

function extractToolResultId(msg: Extract<AgentMessage, { role: "toolResult" }>): string | null {
  const toolCallId = (msg as { toolCallId?: unknown }).toolCallId;
  if (typeof toolCallId === "string" && toolCallId) {
    return toolCallId;
  }
  const toolUseId = (msg as { toolUseId?: unknown }).toolUseId;
  if (typeof toolUseId === "string" && toolUseId) {
    return toolUseId;
  }
  return null;
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
  },
): {
  flushPendingToolResults: () => void;
  getPendingIds: () => string[];
} {
  const originalAppend = sessionManager.appendMessage.bind(sessionManager);
  const pending = new Map<string, string | undefined>();
  const persistMessage = (message: AgentMessage) => {
    const transformer = opts?.transformMessageForPersistence;
    return transformer ? transformer(message) : message;
  };

  // Resolve redact options once at installation time to avoid calling
  // loadConfig() on every text block during persistence.
  const redactOptions: ResolvedRedactOptions = {};
  try {
    // Import config to check redact mode/patterns. If config is unavailable
    // (e.g., in tests), fall back to defaults (mode=undefined uses "tools").
    const configModule = requireConfig("../config/config.js") as {
      loadConfig?: () => { logging?: { redactSensitive?: string; redactPatterns?: string[] } };
    };
    const cfg = configModule.loadConfig?.().logging;
    if (cfg?.redactSensitive) {
      redactOptions.mode = cfg.redactSensitive as RedactSensitiveMode;
    }
    if (cfg?.redactPatterns) {
      redactOptions.patterns = cfg.redactPatterns;
    }
  } catch {
    // Config not available — use defaults.
  }

  const redactEntry = (entry: SessionEntry) => redactEntryForPersistence(entry, redactOptions);

  // Wrap _persist and _rewriteFile to redact secrets at the serialization boundary.
  // This ensures in-memory entries (used by LLM via buildSessionContext) stay
  // unredacted while the on-disk JSONL transcript gets secrets masked.
  //
  // Instead of replicating upstream logic, we wrap the original methods by
  // temporarily swapping `fileEntries` with redacted copies during writes.
  // This preserves all upstream persistence semantics (hasAssistant gating,
  // bulk-flush logic, etc.) — we only transform the data, not the control flow.
  //
  // Cast to access private internals. We intentionally bypass visibility
  // because we're monkey-patching persistence methods. The intersection with
  // SessionManager is avoided because tsgo reduces it to `never` when private
  // properties overlap.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sm = sessionManager as any as {
    persist: boolean;
    sessionFile: string | null;
    flushed: boolean;
    fileEntries: SessionEntry[];
    _persist: (entry: SessionEntry) => void;
    _rewriteFile: () => void;
    appendMessage: SessionManager["appendMessage"];
  };

  const originalPersist = sm._persist.bind(sm);
  const originalRewriteFile = sm._rewriteFile.bind(sm);

  sm._persist = (entry: SessionEntry) => {
    // Swap fileEntries with redacted copies, call original, then restore.
    // The original _persist reads fileEntries directly during bulk-flush.
    const original = sm.fileEntries;
    sm.fileEntries = original.map((e) => redactEntry(e));
    try {
      originalPersist(redactEntry(entry));
    } finally {
      sm.fileEntries = original;
    }
  };

  // Also wrap _rewriteFile which is called during session migration/recovery
  // and writes fileEntries directly without going through _persist.
  sm._rewriteFile = () => {
    const original = sm.fileEntries;
    sm.fileEntries = original.map((e) => redactEntry(e));
    try {
      originalRewriteFile();
    } finally {
      sm.fileEntries = original;
    }
  };

  const persistToolResult = (
    message: AgentMessage,
    meta: { toolCallId?: string; toolName?: string; isSynthetic?: boolean },
  ) => {
    const transformer = opts?.transformToolResultForPersistence;
    return transformer ? transformer(message, meta) : message;
  };

  const allowSyntheticToolResults = opts?.allowSyntheticToolResults ?? true;

  const flushPendingToolResults = () => {
    if (pending.size === 0) {
      return;
    }
    if (allowSyntheticToolResults) {
      for (const [id, name] of pending.entries()) {
        const synthetic = makeMissingToolResult({ toolCallId: id, toolName: name });
        originalAppend(
          persistToolResult(persistMessage(synthetic), {
            toolCallId: id,
            toolName: name,
            isSynthetic: true,
          }) as never,
        );
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
      const id = extractToolResultId(nextMessage as Extract<AgentMessage, { role: "toolResult" }>);
      const toolName = id ? pending.get(id) : undefined;
      if (id) {
        pending.delete(id);
      }
      // Apply hard size cap before persistence to prevent oversized tool results
      // from consuming the entire context window on subsequent LLM calls.
      // Secret redaction is handled separately in the _persist layer so that
      // the in-memory context (used by the LLM) remains unredacted.
      const capped = capToolResultSize(nextMessage);
      return originalAppend(
        persistToolResult(capped, {
          toolCallId: id ?? undefined,
          toolName,
          isSynthetic: false,
        }) as never,
      );
    }

    const toolCalls =
      nextRole === "assistant"
        ? extractAssistantToolCalls(nextMessage as Extract<AgentMessage, { role: "assistant" }>)
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

    const result = originalAppend(persistMessage(nextMessage) as never);

    const sessionFile = (
      sessionManager as { getSessionFile?: () => string | null }
    ).getSessionFile?.();
    if (sessionFile) {
      emitSessionTranscriptUpdate(sessionFile);
    }

    if (toolCalls.length > 0) {
      for (const call of toolCalls) {
        pending.set(call.id, call.name);
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
