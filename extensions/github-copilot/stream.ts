import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import { streamWithPayloadPatch } from "openclaw/plugin-sdk/provider-stream";

type StreamContext = Parameters<StreamFn>[1];
type StreamMessage = StreamContext["messages"][number];

function inferCopilotInitiator(messages: StreamContext["messages"]): "agent" | "user" {
  const last = messages[messages.length - 1];
  return last && last.role !== "user" ? "agent" : "user";
}

function hasCopilotVisionInput(messages: StreamContext["messages"]): boolean {
  return messages.some((message: StreamMessage) => {
    if (message.role === "user" && Array.isArray(message.content)) {
      return message.content.some((item) => item.type === "image");
    }
    if (message.role === "toolResult" && Array.isArray(message.content)) {
      return message.content.some((item) => item.type === "image");
    }
    return false;
  });
}

function buildCopilotDynamicHeaders(params: {
  messages: StreamContext["messages"];
}): Record<string, string> {
  return {
    "X-Initiator": inferCopilotInitiator(params.messages),
    "Openai-Intent": "conversation-edits",
    ...(hasCopilotVisionInput(params.messages) ? { "Copilot-Vision-Request": "true" } : {}),
  };
}

function applyAnthropicPromptCacheMarkers(payloadObj: Record<string, unknown>): void {
  const messages = payloadObj.messages;
  if (!Array.isArray(messages)) {
    return;
  }

  for (const message of messages as Array<{ role?: string; content?: unknown }>) {
    if (message.role === "system" || message.role === "developer") {
      if (typeof message.content === "string") {
        message.content = [
          { type: "text", text: message.content, cache_control: { type: "ephemeral" } },
        ];
        continue;
      }
      if (Array.isArray(message.content) && message.content.length > 0) {
        const last = message.content[message.content.length - 1];
        if (last && typeof last === "object") {
          const record = last as Record<string, unknown>;
          if (record.type !== "thinking" && record.type !== "redacted_thinking") {
            record.cache_control = { type: "ephemeral" };
          }
        }
      }
      continue;
    }

    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (!block || typeof block !== "object") {
          continue;
        }
        const record = block as Record<string, unknown>;
        if (record.type === "thinking" || record.type === "redacted_thinking") {
          delete record.cache_control;
        }
      }
    }
  }
}

export function wrapCopilotAnthropicStream(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    if (model.provider !== "github-copilot" || model.api !== "anthropic-messages") {
      return underlying(model, context, options);
    }

    return streamWithPayloadPatch(
      underlying,
      model,
      context,
      {
        ...options,
        headers: {
          ...buildCopilotDynamicHeaders({ messages: context.messages }),
          ...(options?.headers ?? {}),
        },
      },
      applyAnthropicPromptCacheMarkers,
    );
  };
}
