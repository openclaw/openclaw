import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { TextContent } from "@mariozechner/pi-ai";
import type { SessionManager } from "@mariozechner/pi-coding-agent";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
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
const TOOL_OUTPUT_DIRNAME = "tool-output";
const TOOL_RESULT_DETAILS_EXTERNALIZE_MIN_CHARS = 24_000;
const TOOL_RESULT_TEXT_EXTERNALIZE_MIN_CHARS = 120_000;
const TOOL_RESULT_PREVIEW_MAX_CHARS = 8_000;
const TOOL_RESULT_EXTERNALIZE_NOTICE_PREFIX = "[openclaw] Full tool output saved to";

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

function sanitizeFileNamePart(value: string, fallback: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    return fallback;
  }
  const cleaned = trimmed
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return cleaned || fallback;
}

function truncatePreview(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

function extractToolResultText(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const rec = block as { type?: unknown; text?: unknown };
    if (rec.type === "text" && typeof rec.text === "string") {
      parts.push(rec.text);
    }
  }
  return parts.join("\n");
}

function summarizeDetails(details: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  const preferredKeys = [
    "status",
    "exitCode",
    "error",
    "path",
    "sessionId",
    "runId",
    "success",
    "killed",
    "timedOut",
  ];
  for (const key of preferredKeys) {
    const value = details[key];
    if (
      value === null ||
      typeof value === "boolean" ||
      typeof value === "number" ||
      (typeof value === "string" && value.length <= 500)
    ) {
      summary[key] = value;
    }
  }
  return summary;
}

function getSessionFilePath(sessionManager: SessionManager): string | null {
  return (sessionManager as { getSessionFile?: () => string | null }).getSessionFile?.() ?? null;
}

function externalizeLargeToolResultPayload(params: {
  sessionFile: string | null;
  message: AgentMessage;
  toolCallId?: string;
  toolName?: string;
}): AgentMessage {
  if (!params.sessionFile) {
    return params.message;
  }
  const role = (params.message as { role?: string }).role;
  if (role !== "toolResult") {
    return params.message;
  }

  const messageRecord = params.message as unknown as Record<string, unknown>;
  const details =
    messageRecord.details && typeof messageRecord.details === "object"
      ? (messageRecord.details as Record<string, unknown>)
      : undefined;
  const detailsSerialized = details ? JSON.stringify(details) : "";
  const detailsTooLarge = detailsSerialized.length > TOOL_RESULT_DETAILS_EXTERNALIZE_MIN_CHARS;
  const fullText = extractToolResultText(messageRecord.content);
  const textTooLarge = fullText.length > TOOL_RESULT_TEXT_EXTERNALIZE_MIN_CHARS;
  if (!detailsTooLarge && !textTooLarge) {
    return params.message;
  }

  try {
    const sessionDir = path.dirname(params.sessionFile);
    const outputDir = path.join(sessionDir, TOOL_OUTPUT_DIRNAME);
    fs.mkdirSync(outputDir, { recursive: true });

    const toolName = sanitizeFileNamePart(params.toolName ?? "", "tool");
    const toolCallId = sanitizeFileNamePart(params.toolCallId ?? "", "call");
    const fileName = `${Date.now()}-${toolName}-${toolCallId}.json`;
    const outputPath = path.join(outputDir, fileName);

    const payload = {
      version: 1,
      toolCallId: params.toolCallId ?? null,
      toolName: params.toolName ?? null,
      savedAt: new Date().toISOString(),
      ...(detailsTooLarge ? { details } : {}),
      ...(textTooLarge ? { text: fullText } : {}),
    };
    const payloadText = `${JSON.stringify(payload, null, 2)}\n`;
    fs.writeFileSync(outputPath, payloadText, "utf-8");

    const payloadSha = crypto.createHash("sha256").update(payloadText).digest("hex");
    const relativePath = path.relative(sessionDir, outputPath) || outputPath;
    const outputRef = {
      kind: "tool_result_payload",
      path: relativePath,
      bytes: Buffer.byteLength(payloadText, "utf-8"),
      sha256: payloadSha,
      contains: {
        details: detailsTooLarge,
        text: textTooLarge,
      },
    };

    const nextMessage = { ...messageRecord };
    if (detailsTooLarge) {
      nextMessage.details = {
        ...summarizeDetails(details ?? {}),
        outputRef,
      };
    }
    if (textTooLarge && Array.isArray(nextMessage.content)) {
      const preview = truncatePreview(fullText, TOOL_RESULT_PREVIEW_MAX_CHARS);
      const notice =
        `\n\n${TOOL_RESULT_EXTERNALIZE_NOTICE_PREFIX} ${relativePath} ` +
        `(sha256: ${payloadSha.slice(0, 12)}..., bytes: ${outputRef.bytes}).`;
      let injected = false;
      const compacted = nextMessage.content.flatMap((block) => {
        if (!block || typeof block !== "object") {
          return [block];
        }
        const rec = block as { type?: unknown; text?: unknown };
        if (rec.type !== "text") {
          return [block];
        }
        if (injected) {
          return [];
        }
        injected = true;
        return [
          {
            ...(block as Record<string, unknown>),
            text: `${preview}${notice}`,
          },
        ];
      });
      if (!injected) {
        compacted.unshift({ type: "text", text: `${preview}${notice}` });
      }
      nextMessage.content = compacted;
    }
    return nextMessage as unknown as AgentMessage;
  } catch {
    return params.message;
  }
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
      const id = extractToolResultId(nextMessage as Extract<AgentMessage, { role: "toolResult" }>);
      const toolName = id ? pending.get(id) : undefined;
      if (id) {
        pending.delete(id);
      }
      // Apply hard size cap before persistence to prevent oversized tool results
      // from consuming the entire context window on subsequent LLM calls.
      const capped = capToolResultSize(persistMessage(nextMessage));
      const transformed = persistToolResult(capped, {
        toolCallId: id ?? undefined,
        toolName,
        isSynthetic: false,
      });
      const persisted = applyBeforeWriteHook(transformed);
      if (!persisted) {
        return undefined;
      }
      const compactedForTranscript = externalizeLargeToolResultPayload({
        sessionFile: getSessionFilePath(sessionManager),
        message: persisted,
        toolCallId: id ?? undefined,
        toolName,
      });
      return originalAppend(compactedForTranscript as never);
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
