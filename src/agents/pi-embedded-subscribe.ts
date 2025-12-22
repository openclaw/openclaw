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
}) {
  const assistantTexts: string[] = [];
  const toolMetas: Array<{ toolName?: string; meta?: string }> = [];
  const toolMetaById = new Map<string, string | undefined>();
  let deltaBuffer = "";
  let lastStreamedAssistant: string | undefined;

  const toolDebouncer = createToolDebouncer((toolName, metas) => {
    if (!params.onPartialReply) return;
    const text = formatToolAggregate(toolName, metas);
    const { text: cleanedText, mediaUrls } = splitMediaFromOutput(text);
    void params.onPartialReply({
      text: cleanedText,
      mediaUrls: mediaUrls?.length ? mediaUrls : undefined,
    });
  });

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
              const next = deltaBuffer.trim();
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
          const text = extractAssistantText(msg as AssistantMessage);
          if (text) assistantTexts.push(text);
          deltaBuffer = "";
        }
      }

      if (evt.type === "agent_end") {
        toolDebouncer.flush();
      }
    },
  );

  return {
    assistantTexts,
    toolMetas,
    unsubscribe,
    flush: () => toolDebouncer.flush(),
  };
}
