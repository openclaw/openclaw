import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { TextContent } from "@mariozechner/pi-ai";
import type { SessionManager } from "@mariozechner/pi-coding-agent";
import path from "node:path";
import { emitSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { HARD_MAX_TOOL_RESULT_CHARS } from "./pi-embedded-runner/tool-result-truncation.js";
import { makeMissingToolResult, sanitizeToolCallInputs } from "./session-transcript-repair.js";
import { makeExternalizedToolResultDigest, storeToolResultPayload } from "./tool-result-store.js";

const GUARD_TRUNCATION_SUFFIX =
  "\n\n⚠️ [Content truncated during persistence — original exceeded size limit. " +
  "Use offset/limit parameters or request specific sections for large content.]";

// New default: externalize large tool results instead of permanently truncating them.
// This keeps the session transcript small (token-efficient), while allowing the model to
// fetch the full content on demand.
const DEFAULT_EXTERNALIZE_TOOL_RESULT_CHARS = 12_000;

/**
 * Truncate oversized text content blocks in a tool result message.
 * Returns the original message if under the limit, or a new message with
 * truncated text blocks otherwise.
 */
function analyzeToolResultContent(msg: AgentMessage): {
  ok: boolean;
  totalTextChars: number;
  hasImages: boolean;
} {
  const role = (msg as { role?: string }).role;
  if (role !== "toolResult") {
    return { ok: false, totalTextChars: 0, hasImages: false };
  }
  const content = (msg as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return { ok: false, totalTextChars: 0, hasImages: false };
  }

  let totalTextChars = 0;
  let hasImages = false;
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const type = (block as { type?: unknown }).type;
    if (type === "image") {
      hasImages = true;
      continue;
    }
    if (type !== "text") {
      continue;
    }
    const text = (block as TextContent).text;
    if (typeof text === "string") {
      totalTextChars += text.length;
    }
  }

  return { ok: true, totalTextChars, hasImages };
}

function truncateToolResultForPersistence(msg: AgentMessage, totalTextChars: number): AgentMessage {
  const content = (msg as { content?: unknown }).content;
  if (!Array.isArray(content) || totalTextChars <= HARD_MAX_TOOL_RESULT_CHARS) {
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
          persistToolResult(synthetic, {
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
      const analysis = analyzeToolResultContent(nextMessage);

      let persistedMessage = nextMessage;

      // Externalize large text-only tool results so they don't permanently bloat the transcript.
      if (
        id &&
        analysis.ok &&
        !analysis.hasImages &&
        analysis.totalTextChars > DEFAULT_EXTERNALIZE_TOOL_RESULT_CHARS
      ) {
        const sessionFile = (
          sessionManager as { getSessionFile?: () => string | null }
        ).getSessionFile?.();
        const sessionId = (
          sessionManager as { getSessionId?: () => string | null }
        ).getSessionId?.();

        if (sessionFile && sessionId) {
          const sessionDir = path.dirname(sessionFile);
          const stored = storeToolResultPayload({
            message: nextMessage,
            options: {
              sessionDir,
              sessionId,
              toolCallId: id,
            },
            preview: {
              headChars: 1500,
              tailChars: 1500,
            },
          });

          if (stored) {
            const digest = makeExternalizedToolResultDigest({
              toolName,
              toolCallId: id,
              storedRef: stored.ref,
              originalChars: stored.totalTextChars,
              previewHead: stored.previewHead,
              previewTail: stored.previewTail,
              maxDigestChars: 4000,
            });
            persistedMessage = {
              ...(nextMessage as unknown as Record<string, unknown>),
              content: [{ type: "text", text: digest }],
            } as AgentMessage;
          }
        }
      }

      // Safety net: hard truncate if the persisted tool result is still enormous.
      const persistedAnalysis = analyzeToolResultContent(persistedMessage);
      if (persistedAnalysis.ok) {
        persistedMessage = truncateToolResultForPersistence(
          persistedMessage,
          persistedAnalysis.totalTextChars,
        );
      }

      return originalAppend(
        persistToolResult(persistedMessage, {
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

    const result = originalAppend(nextMessage as never);

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
