import type { AgentEvent, AppMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { AgentSession } from "@mariozechner/pi-coding-agent";

import {
  createToolDebouncer,
  formatToolAggregate,
} from "../auto-reply/tool-meta.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { splitMediaFromOutput } from "../media/parse.js";
import {
  extractAssistantText,
  inferToolMetaFromArgs,
} from "./pi-embedded-utils.js";

const THINKING_TAG_RE = /<\s*\/?\s*think(?:ing)?\s*>/gi;
const THINKING_OPEN_RE = /<\s*think(?:ing)?\s*>/i;
const THINKING_CLOSE_RE = /<\s*\/\s*think(?:ing)?\s*>/i;

function stripThinkingSegments(text: string): string {
  if (!text || !THINKING_TAG_RE.test(text)) return text;
  THINKING_TAG_RE.lastIndex = 0;
  let result = "";
  let lastIndex = 0;
  let inThinking = false;
  for (const match of text.matchAll(THINKING_TAG_RE)) {
    const idx = match.index ?? 0;
    if (!inThinking) {
      result += text.slice(lastIndex, idx);
    }
    const tag = match[0].toLowerCase();
    inThinking = !tag.includes("/");
    lastIndex = idx + match[0].length;
  }
  if (!inThinking) {
    result += text.slice(lastIndex);
  }
  return result;
}

function stripUnpairedThinkingTags(text: string): string {
  if (!text) return text;
  const hasOpen = THINKING_OPEN_RE.test(text);
  const hasClose = THINKING_CLOSE_RE.test(text);
  if (hasOpen && hasClose) return text;
  if (!hasOpen) return text.replace(THINKING_CLOSE_RE, "");
  if (!hasClose) return text.replace(THINKING_OPEN_RE, "");
  return text;
}

export function subscribeEmbeddedPiSession(params: {
  session: AgentSession;
  runId: string;
  verboseLevel?: "off" | "on";
  shouldEmitToolResult?: () => boolean;
  onToolResult?: (payload: {
    text?: string;
    mediaUrls?: string[];
  }) => void | Promise<void>;
  onPartialReply?: (payload: {
    text?: string;
    mediaUrls?: string[];
  }) => void | Promise<void>;
  onAgentEvent?: (evt: {
    stream: string;
    data: Record<string, unknown>;
  }) => void;
  enforceFinalTag?: boolean;
}) {
  const assistantTexts: string[] = [];
  const toolMetas: Array<{ toolName?: string; meta?: string }> = [];
  const toolMetaById = new Map<string, string | undefined>();
  let deltaBuffer = "";
  let lastStreamedAssistant: string | undefined;
  let compactionInFlight = false;
  let pendingCompactionRetry = 0;
  let compactionRetryResolve: (() => void) | undefined;
  let compactionRetryPromise: Promise<void> | null = null;

  const ensureCompactionPromise = () => {
    if (!compactionRetryPromise) {
      compactionRetryPromise = new Promise((resolve) => {
        compactionRetryResolve = resolve;
      });
    }
  };

  const noteCompactionRetry = () => {
    pendingCompactionRetry += 1;
    ensureCompactionPromise();
  };

  const resolveCompactionRetry = () => {
    if (pendingCompactionRetry <= 0) return;
    pendingCompactionRetry -= 1;
    if (pendingCompactionRetry === 0 && !compactionInFlight) {
      compactionRetryResolve?.();
      compactionRetryResolve = undefined;
      compactionRetryPromise = null;
    }
  };

  const maybeResolveCompactionWait = () => {
    if (pendingCompactionRetry === 0 && !compactionInFlight) {
      compactionRetryResolve?.();
      compactionRetryResolve = undefined;
      compactionRetryPromise = null;
    }
  };
  const FINAL_START_RE = /<\s*final\s*>/i;
  const FINAL_END_RE = /<\s*\/\s*final\s*>/i;
  // Local providers sometimes emit malformed tags; normalize before filtering.
  const sanitizeFinalText = (text: string): string => {
    if (!text) return text;
    const hasStart = FINAL_START_RE.test(text);
    const hasEnd = FINAL_END_RE.test(text);
    if (hasStart && !hasEnd) return text.replace(FINAL_START_RE, "");
    if (!hasStart && hasEnd) return text.replace(FINAL_END_RE, "");
    return text;
  };
  const extractFinalText = (text: string): string | undefined => {
    const cleaned = sanitizeFinalText(text);
    const startMatch = FINAL_START_RE.exec(cleaned);
    if (!startMatch) return undefined;
    const startIndex = startMatch.index + startMatch[0].length;
    const afterStart = cleaned.slice(startIndex);
    const endMatch = FINAL_END_RE.exec(afterStart);
    const endIndex = endMatch ? endMatch.index : afterStart.length;
    return afterStart.slice(0, endIndex);
  };

  const toolDebouncer = createToolDebouncer((toolName, metas) => {
    if (!params.onPartialReply) return;
    const text = formatToolAggregate(toolName, metas);
    const { text: cleanedText, mediaUrls } = splitMediaFromOutput(text);
    void params.onPartialReply({
      text: cleanedText,
      mediaUrls: mediaUrls?.length ? mediaUrls : undefined,
    });
  });

  const resetForCompactionRetry = () => {
    assistantTexts.length = 0;
    toolMetas.length = 0;
    toolMetaById.clear();
    deltaBuffer = "";
    lastStreamedAssistant = undefined;
    toolDebouncer.flush();
  };

  const unsubscribe = params.session.subscribe(
    (evt: AgentEvent | { type: string; [k: string]: unknown }) => {
      if (evt.type === "tool_execution_start") {
        const toolName = String(
          (evt as AgentEvent & { toolName: string }).toolName,
        );
        const toolCallId = String(
          (evt as AgentEvent & { toolCallId: string }).toolCallId,
        );
        const args = (evt as AgentEvent & { args: unknown }).args;
        const meta = inferToolMetaFromArgs(toolName, args);
        toolMetaById.set(toolCallId, meta);

        emitAgentEvent({
          runId: params.runId,
          stream: "tool",
          data: {
            phase: "start",
            name: toolName,
            toolCallId,
            args: args as Record<string, unknown>,
          },
        });
        params.onAgentEvent?.({
          stream: "tool",
          data: { phase: "start", name: toolName, toolCallId },
        });
      }

      if (evt.type === "tool_execution_end") {
        const toolName = String(
          (evt as AgentEvent & { toolName: string }).toolName,
        );
        const toolCallId = String(
          (evt as AgentEvent & { toolCallId: string }).toolCallId,
        );
        const isError = Boolean(
          (evt as AgentEvent & { isError: boolean }).isError,
        );
        const meta = toolMetaById.get(toolCallId);
        toolMetas.push({ toolName, meta });
        toolDebouncer.push(toolName, meta);

        emitAgentEvent({
          runId: params.runId,
          stream: "tool",
          data: {
            phase: "result",
            name: toolName,
            toolCallId,
            meta,
            isError,
          },
        });
        params.onAgentEvent?.({
          stream: "tool",
          data: {
            phase: "result",
            name: toolName,
            toolCallId,
            meta,
            isError,
          },
        });

        const emitToolResult =
          typeof params.shouldEmitToolResult === "function"
            ? params.shouldEmitToolResult()
            : params.verboseLevel === "on";
        if (emitToolResult && params.onToolResult) {
          const agg = formatToolAggregate(toolName, meta ? [meta] : undefined);
          const { text: cleanedText, mediaUrls } = splitMediaFromOutput(agg);
          if (cleanedText || (mediaUrls && mediaUrls.length > 0)) {
            try {
              void params.onToolResult({
                text: cleanedText,
                mediaUrls: mediaUrls?.length ? mediaUrls : undefined,
              });
            } catch {
              // ignore tool result delivery failures
            }
          }
        }
      }

      if (evt.type === "message_update") {
        const msg = (evt as AgentEvent & { message: AppMessage }).message;
        if (msg?.role === "assistant") {
          const assistantEvent = (
            evt as AgentEvent & { assistantMessageEvent?: unknown }
          ).assistantMessageEvent;
          const assistantRecord =
            assistantEvent && typeof assistantEvent === "object"
              ? (assistantEvent as Record<string, unknown>)
              : undefined;
          const evtType =
            typeof assistantRecord?.type === "string"
              ? assistantRecord.type
              : "";
          if (
            evtType === "text_delta" ||
            evtType === "text_start" ||
            evtType === "text_end"
          ) {
            const chunk =
              typeof assistantRecord?.delta === "string"
                ? assistantRecord.delta
                : typeof assistantRecord?.content === "string"
                  ? assistantRecord.content
                  : "";
            if (chunk) {
              deltaBuffer += chunk;
              const cleaned = params.enforceFinalTag
                ? stripThinkingSegments(stripUnpairedThinkingTags(deltaBuffer))
                : stripThinkingSegments(deltaBuffer);
              const next = params.enforceFinalTag
                ? (extractFinalText(cleaned)?.trim() ?? cleaned.trim())
                : cleaned.trim();
              if (next && next !== lastStreamedAssistant) {
                lastStreamedAssistant = next;
                const { text: cleanedText, mediaUrls } =
                  splitMediaFromOutput(next);
                emitAgentEvent({
                  runId: params.runId,
                  stream: "assistant",
                  data: {
                    text: cleanedText,
                    mediaUrls: mediaUrls?.length ? mediaUrls : undefined,
                  },
                });
                params.onAgentEvent?.({
                  stream: "assistant",
                  data: {
                    text: cleanedText,
                    mediaUrls: mediaUrls?.length ? mediaUrls : undefined,
                  },
                });
                if (params.onPartialReply) {
                  void params.onPartialReply({
                    text: cleanedText,
                    mediaUrls: mediaUrls?.length ? mediaUrls : undefined,
                  });
                }
              }
            }
          }
        }
      }

      if (evt.type === "message_end") {
        const msg = (evt as AgentEvent & { message: AppMessage }).message;
        if (msg?.role === "assistant") {
          const cleaned = params.enforceFinalTag
            ? stripThinkingSegments(
                stripUnpairedThinkingTags(
                  extractAssistantText(msg as AssistantMessage),
                ),
              )
            : stripThinkingSegments(
                extractAssistantText(msg as AssistantMessage),
              );
          const text =
            params.enforceFinalTag && cleaned
              ? (extractFinalText(cleaned)?.trim() ?? cleaned)
              : cleaned;
          if (text) assistantTexts.push(text);
          deltaBuffer = "";
        }
      }

      if (evt.type === "auto_compaction_start") {
        compactionInFlight = true;
        ensureCompactionPromise();
      }

      if (evt.type === "auto_compaction_end") {
        compactionInFlight = false;
        const willRetry = Boolean((evt as { willRetry?: unknown }).willRetry);
        if (willRetry) {
          noteCompactionRetry();
          resetForCompactionRetry();
        } else {
          maybeResolveCompactionWait();
        }
      }

      if (evt.type === "agent_end") {
        toolDebouncer.flush();
        if (pendingCompactionRetry > 0) {
          resolveCompactionRetry();
        } else {
          maybeResolveCompactionWait();
        }
      }
    },
  );

  return {
    assistantTexts,
    toolMetas,
    unsubscribe,
    flush: () => toolDebouncer.flush(),
    waitForCompactionRetry: () => {
      if (compactionInFlight || pendingCompactionRetry > 0) {
        ensureCompactionPromise();
        return compactionRetryPromise ?? Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        queueMicrotask(() => {
          if (compactionInFlight || pendingCompactionRetry > 0) {
            ensureCompactionPromise();
            void (compactionRetryPromise ?? Promise.resolve()).then(resolve);
          } else {
            resolve();
          }
        });
      });
    },
  };
}
