/**
 * Gateway Stream Handler Hook
 *
 * Processes gateway streaming events and routes them appropriately:
 * - Text deltas go to message content
 * - Tool outputs go ONLY to tool calls (not message content)
 */

import { useEffect, useCallback } from "react";
import { toast } from "sonner";
import type { GatewayEvent } from "@/lib/api";
import { useOptionalGateway } from "@/providers/GatewayProvider";
import { useSessionStore } from "@/stores/useSessionStore";
import type { ToolCall } from "@/lib/api/sessions";

interface GatewayChatEvent {
  runId: string;
  sessionKey: string;
  seq: number;
  state: "delta" | "final" | "error" | "aborted";
  message?: unknown;
  delta?: {
    type: string;
    text?: string;
  };
  errorMessage?: string;
}

type GatewayAgentEvent = {
  runId: string;
  seq: number;
  stream: string;
  ts: number;
  data: Record<string, unknown>;
  sessionKey?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function toPrettyString(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * Extracts text content from message structure
 */
function extractTextContent(message: unknown): string {
  if (!isRecord(message)) return "";
  const content = message.content;
  if (!Array.isArray(content)) return "";

  const textBlocks = content
    .filter((block) => isRecord(block) && block.type === "text")
    .map((block) => (typeof block.text === "string" ? block.text : ""));

  return textBlocks.join("\n");
}

/**
 * Extracts tool calls from message structure
 */
function extractToolCalls(message: unknown): ToolCall[] {
  if (!isRecord(message)) return [];
  const toolUse = message.toolUse;
  if (!Array.isArray(toolUse)) {
    return [];
  }

  return toolUse
    .filter((tool) => isRecord(tool))
    .map((tool) => ({
    id: asString(tool.id) ?? "unknown",
    name: asString(tool.name) ?? "unknown",
    status: "done" as const,
    input: toPrettyString(tool.input),
  }));
}

export interface UseGatewayStreamHandlerOptions {
  /** Enable/disable the handler */
  enabled?: boolean;
}

/**
 * Hook that processes gateway streaming events and updates session store appropriately.
 *
 * Ensures tool outputs are NEVER added to message content - they only go to tool calls.
 */
export function useGatewayStreamHandler(
  options: UseGatewayStreamHandlerOptions = {}
) {
  const { enabled = true } = options;
  const gatewayCtx = useOptionalGateway();

  const startStreaming = useSessionStore((s) => s.startStreaming);
  const setStreamingContent = useSessionStore((s) => s.setStreamingContent);
  const appendStreamingContent = useSessionStore((s) => s.appendStreamingContent);
  const updateToolCall = useSessionStore((s) => s.updateToolCall);
  const finishStreaming = useSessionStore((s) => s.finishStreaming);
  const clearStreaming = useSessionStore((s) => s.clearStreaming);
  const findSessionKeyByRunId = useSessionStore((s) => s.findSessionKeyByRunId);

  const ensureStreaming = useCallback(
    (sessionKey: string, runId: string) => {
      const existing = useSessionStore.getState().streamingMessages[sessionKey];
      if (!existing) {
        startStreaming(sessionKey, runId);
      }
    },
    [startStreaming]
  );

  const handleChatEvent = useCallback((event: GatewayChatEvent) => {
    const { sessionKey, state } = event;
    ensureStreaming(sessionKey, event.runId);

    switch (state) {
      case "delta": {
        // Gateway `chat` delta uses the full assistant buffer in `message.content[]` (not a token delta).
        if (event.message) {
          setStreamingContent(sessionKey, extractTextContent(event.message));
          break;
        }
        // Fallback for older clients that emit a token delta field.
        if (event.delta?.type === "text" && event.delta.text) {
          appendStreamingContent(sessionKey, event.delta.text);
        }
        break;
      }

      case "final": {
        if (event.message) {
          setStreamingContent(sessionKey, extractTextContent(event.message));
          for (const toolCall of extractToolCalls(event.message)) {
            updateToolCall(sessionKey, toolCall);
          }
        }

        finishStreaming(sessionKey);
        break;
      }

      case "error": {
        console.error("[StreamHandler] Chat error:", event.errorMessage);
        finishStreaming(sessionKey);
        break;
      }

      case "aborted": {
        console.debug("[StreamHandler] Chat aborted");
        clearStreaming(sessionKey);
        break;
      }
    }
  }, [appendStreamingContent, clearStreaming, ensureStreaming, finishStreaming, setStreamingContent, updateToolCall]);

  const handleAgentEvent = useCallback(
    (raw: GatewayAgentEvent) => {
      const data = raw.data ?? {};
      const explicitSessionKey = asString(raw.sessionKey) ?? asString(data.sessionKey);
      const sessionKey = explicitSessionKey ?? findSessionKeyByRunId(raw.runId);
      if (!sessionKey) return;

      if (raw.stream === "tool") {
        const toolCallId = asString(data.toolCallId) ?? asString(data.id);
        if (!toolCallId) return;

        const toolName = asString(data.name) ?? asString(data.toolName) ?? "unknown";
        const phase = asString(data.phase) ?? asString(data.status);

        let status: ToolCall["status"] = "running";
        if (phase === "finish" || phase === "done" || phase === "end" || phase === "complete") {
          status = "done";
        } else if (phase === "error" || phase === "failed") {
          status = "error";
        } else if (phase === "start" || phase === "running") {
          status = "running";
        }

        const duration =
          asString(data.duration) ??
          (typeof data.durationMs === "number" ? `${Math.round(data.durationMs)}ms` : undefined);

        ensureStreaming(sessionKey, raw.runId);
        updateToolCall(sessionKey, {
          id: toolCallId,
          name: toolName,
          status,
          input: toPrettyString(data.input),
          output: toPrettyString(data.output ?? data.result ?? data.text),
          duration,
          progress: typeof data.progress === "number" ? data.progress : undefined,
        });
        return;
      }

      if (raw.stream === "compaction") {
        const phase = asString(data.phase);
        const toastId = `compaction:${sessionKey}`;
        if (phase === "start") {
          toast.loading("Compacting context…", { id: toastId });
        } else if (phase === "end" || phase === "done") {
          toast.dismiss(toastId);
        } else if (phase === "error") {
          toast.error("Compaction failed", { id: toastId });
        }
      }
    },
    [ensureStreaming, findSessionKeyByRunId, updateToolCall]
  );

  const handleEvent = useCallback((event: GatewayEvent) => {
    // Handle chat streaming events
    if (event.event === "chat") {
      handleChatEvent(event.payload as GatewayChatEvent);
      return;
    }

    // Tool output + compaction come from `agent` stream events.
    if (event.event === "agent") {
      handleAgentEvent(event.payload as GatewayAgentEvent);
      return;
    }
  }, [handleAgentEvent, handleChatEvent]);

  useEffect(() => {
    if (!enabled) {return;}
    if (!gatewayCtx) {return;}
    return gatewayCtx.addEventListener(handleEvent);
  }, [enabled, gatewayCtx, handleEvent]);
}
