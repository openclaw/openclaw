/**
 * Event Bridge — Normalizes streaming events from different runtimes
 * into the unified `RuntimeEvent` type.
 *
 * pi-agent emits `AgentEvent` (from @mariozechner/pi-agent-core).
 * Claude Agent SDK emits `SDKMessage` (from @anthropic-ai/claude-agent-sdk).
 * Both are converted to `RuntimeEvent` for downstream consumers.
 */

import type { RuntimeEvent, RuntimeMessage } from "./types.js";

// ---------------------------------------------------------------------------
// From pi-agent AgentEvent → RuntimeEvent
// ---------------------------------------------------------------------------

/**
 * Convert a pi-agent `AgentEvent` to `RuntimeEvent[]`.
 * Some events map 1:1, others may produce zero or multiple events.
 *
 * Accepts `unknown` to avoid importing pi-agent types.
 */
export function fromPiAgentEvent(event: unknown): RuntimeEvent[] {
  const e = event as { type: string; [key: string]: unknown };
  switch (e.type) {
    case "agent_start":
      return [{ type: "agent_start" }];

    case "agent_end":
      return [
        {
          type: "agent_end",
          messages: ((e.messages as unknown[]) ?? []).map(normalizePiMessage),
        },
      ];

    case "turn_start":
      return [{ type: "turn_start" }];

    case "turn_end":
      return [{ type: "turn_end", message: normalizePiMessage(e.message) }];

    case "message_start":
      return [{ type: "message_start", message: normalizePiMessage(e.message) }];

    case "message_update": {
      // Extract text delta from the assistantMessageEvent
      const ame = e.assistantMessageEvent as { type?: string; text?: string } | undefined;
      if (ame?.type === "text" && ame.text) {
        return [{ type: "message_delta", text: ame.text }];
      }
      return [];
    }

    case "message_end":
      return [{ type: "message_end", message: normalizePiMessage(e.message) }];

    case "tool_execution_start":
      return [
        {
          type: "tool_execution_start",
          toolCallId: e.toolCallId as string,
          toolName: e.toolName as string,
          args: e.args,
        },
      ];

    case "tool_execution_update":
      return [
        {
          type: "tool_execution_update",
          toolCallId: e.toolCallId as string,
          toolName: e.toolName as string,
          partial: e.partialResult,
        },
      ];

    case "tool_execution_end":
      return [
        {
          type: "tool_execution_end",
          toolCallId: e.toolCallId as string,
          toolName: e.toolName as string,
          result: e.result,
          isError: (e.isError as boolean) ?? false,
        },
      ];

    case "auto_compaction_start":
      return [{ type: "compaction_start", reason: (e.reason as string) ?? "threshold" }];

    case "auto_compaction_end":
      return [{ type: "compaction_end", aborted: (e.aborted as boolean) ?? false }];

    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// From Claude Agent SDK SDKMessage → RuntimeEvent
// ---------------------------------------------------------------------------

/**
 * Convert a Claude Agent SDK `SDKMessage` to `RuntimeEvent[]`.
 *
 * Accepts `unknown` to avoid importing SDK types.
 */
export function fromClaudeSdkMessage(message: unknown): RuntimeEvent[] {
  const msg = message as { type: string; subtype?: string; [key: string]: unknown };
  const events: RuntimeEvent[] = [];

  switch (msg.type) {
    case "assistant": {
      const betaMessage = msg.message as {
        stop_reason?: string;
        content?: Array<{
          type: string;
          text?: string;
          id?: string;
          name?: string;
          input?: unknown;
        }>;
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          cache_read_input_tokens?: number;
          cache_creation_input_tokens?: number;
        };
      };
      events.push({
        type: "message_end",
        message: normalizeClaudeSdkAssistantMessage(betaMessage),
      });
      if (betaMessage.usage) {
        events.push({
          type: "usage",
          input: betaMessage.usage.input_tokens ?? 0,
          output: betaMessage.usage.output_tokens ?? 0,
          cacheRead: betaMessage.usage.cache_read_input_tokens,
          cacheWrite: betaMessage.usage.cache_creation_input_tokens,
        });
      }
      break;
    }

    case "stream_event": {
      const evt = msg.event as {
        type: string;
        delta?: { type: string; text?: string };
        content_block?: { type: string; id?: string; name?: string };
      };
      if (
        evt.type === "content_block_delta" &&
        evt.delta?.type === "text_delta" &&
        evt.delta.text
      ) {
        events.push({ type: "message_delta", text: evt.delta.text });
      } else if (evt.type === "content_block_start" && evt.content_block?.type === "tool_use") {
        events.push({
          type: "tool_execution_start",
          toolCallId: evt.content_block.id ?? "",
          toolName: evt.content_block.name ?? "",
          args: undefined,
        });
      } else if (evt.type === "message_start") {
        events.push({
          type: "message_start",
          message: { role: "assistant", content: "" },
        });
      }
      break;
    }

    case "result": {
      if (msg.subtype === "success") {
        const usage = msg.usage as {
          input_tokens?: number;
          output_tokens?: number;
          cache_read_input_tokens?: number;
          cache_creation_input_tokens?: number;
        };
        if (usage) {
          events.push({
            type: "usage",
            input: usage.input_tokens ?? 0,
            output: usage.output_tokens ?? 0,
            cacheRead: usage.cache_read_input_tokens,
            cacheWrite: usage.cache_creation_input_tokens,
          });
        }
        events.push({ type: "agent_end", messages: [] });
      } else {
        const errors = msg.errors as string[] | undefined;
        events.push({
          type: "error",
          error: errors?.join(", ") ?? "Unknown error",
          isRetryable: false,
        });
      }
      break;
    }

    case "system": {
      if (msg.subtype === "status" && msg.status === "compacting") {
        events.push({ type: "compaction_start", reason: "auto" });
      }
      break;
    }

    default:
      break;
  }

  return events;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizePiMessage(msg: unknown): RuntimeMessage {
  if (!msg || typeof msg !== "object") {
    return { role: "user", content: "" };
  }
  const m = msg as { role?: string; content?: unknown };
  return {
    role: normalizeRole(m.role),
    content: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""),
    raw: msg,
  };
}

function normalizeClaudeSdkAssistantMessage(msg: {
  content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
}): RuntimeMessage {
  const textBlocks = (msg.content ?? [])
    .filter((c) => c.type === "text" && c.text)
    .map((c) => c.text!)
    .join("");
  return {
    role: "assistant",
    content: textBlocks,
    raw: msg,
  };
}

function normalizeRole(role?: string): "user" | "assistant" | "system" {
  if (role === "assistant") {
    return "assistant";
  }
  if (role === "system") {
    return "system";
  }
  return "user";
}
