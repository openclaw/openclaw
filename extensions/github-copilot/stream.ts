// Github Copilot plugin module implements stream behavior.
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { Context } from "openclaw/plugin-sdk/llm";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { buildCopilotIdeHeaders, COPILOT_INTEGRATION_ID } from "openclaw/plugin-sdk/provider-auth";
import {
  applyAnthropicEphemeralCacheControlMarkers,
  streamWithPayloadPatch,
} from "openclaw/plugin-sdk/provider-stream-shared";
import { sanitizeCopilotResponsePayload } from "./connection-bound-ids.js";
import { stripCopilotAssistantThinkingMessages } from "./replay-policy.js";

const MAX_ACTIVE_COPILOT_SESSIONS = 32;
// Provider wrappers are rebuilt each turn. Remember active sessions at module scope so
// only the first request after process startup is treated as a cold resume.
const activeCopilotSessions = new Set<string>();

function containsCopilotContentType(value: unknown, type: string): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => containsCopilotContentType(item, type));
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  const entry = value as { type?: unknown; content?: unknown };
  return entry.type === type || containsCopilotContentType(entry.content, type);
}

function inferCopilotInitiator(messages: Context["messages"]): "agent" | "user" {
  const last = messages[messages.length - 1];
  if (!last) {
    return "user";
  }
  if (last.role === "user" && containsCopilotContentType(last.content, "tool_result")) {
    return "agent";
  }
  return last.role === "user" ? "user" : "agent";
}

function hasCopilotVisionInput(messages: Context["messages"]): boolean {
  return messages.some((message) => {
    if (message.role === "user" && Array.isArray(message.content)) {
      return message.content.some((item) => containsCopilotContentType(item, "image"));
    }
    if (message.role === "toolResult" && Array.isArray(message.content)) {
      return message.content.some((item) => containsCopilotContentType(item, "image"));
    }
    return false;
  });
}

export function buildCopilotDynamicHeaders(params: {
  messages: Context["messages"];
  hasImages: boolean;
}): Record<string, string> {
  return {
    ...buildCopilotIdeHeaders(),
    "Copilot-Integration-Id": COPILOT_INTEGRATION_ID,
    "Openai-Organization": "github-copilot",
    "x-initiator": inferCopilotInitiator(params.messages),
    ...(params.hasImages ? { "Copilot-Vision-Request": "true" } : {}),
  };
}

function patchOnPayloadResult(
  result: unknown,
  originalPayload: unknown,
  stripEncryptedReasoning: boolean,
  sessionKey: string | undefined,
): unknown {
  if (result && typeof result === "object" && "then" in result) {
    return Promise.resolve(result).then((next) => {
      sanitizeCopilotResponsePayload(next === undefined ? originalPayload : next, {
        stripEncryptedReasoning,
      });
      rememberActiveCopilotSession(sessionKey);
      return next;
    });
  }
  sanitizeCopilotResponsePayload(result === undefined ? originalPayload : result, {
    stripEncryptedReasoning,
  });
  rememberActiveCopilotSession(sessionKey);
  return result;
}

function rememberActiveCopilotSession(sessionKey: string | undefined): void {
  if (!sessionKey) {
    return;
  }
  activeCopilotSessions.delete(sessionKey);
  activeCopilotSessions.add(sessionKey);
  if (activeCopilotSessions.size > MAX_ACTIVE_COPILOT_SESSIONS) {
    const oldest = activeCopilotSessions.values().next().value;
    if (oldest !== undefined) {
      activeCopilotSessions.delete(oldest);
    }
  }
}

function buildCopilotRequestHeaders(
  context: Parameters<StreamFn>[1],
  headers: Record<string, string> | undefined,
): Record<string, string> {
  return {
    ...buildCopilotDynamicHeaders({
      messages: context.messages,
      hasImages: hasCopilotVisionInput(context.messages),
    }),
    ...headers,
  };
}

function patchCopilotAnthropicPayload(payload: Record<string, unknown>): void {
  if (Array.isArray(payload.messages)) {
    payload.messages = stripCopilotAssistantThinkingMessages(payload.messages);
  }
  applyAnthropicEphemeralCacheControlMarkers(payload);
}

export function wrapCopilotAnthropicStream(
  baseStreamFn: StreamFn | undefined,
): StreamFn | undefined {
  if (!baseStreamFn) {
    return undefined;
  }
  const underlying = baseStreamFn;
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
        headers: buildCopilotRequestHeaders(context, options?.headers),
      },
      patchCopilotAnthropicPayload,
    );
  };
}

export function wrapCopilotOpenAIResponsesStream(
  baseStreamFn: StreamFn | undefined,
): StreamFn | undefined {
  if (!baseStreamFn) {
    return undefined;
  }
  const underlying = baseStreamFn;
  return (model, context, options) => {
    if (model.provider !== "github-copilot" || model.api !== "openai-responses") {
      return underlying(model, context, options);
    }

    const sessionKey = options?.sessionId?.trim() || undefined;
    const stripEncryptedReasoning = !sessionKey || !activeCopilotSessions.has(sessionKey);
    const originalOnPayload = options?.onPayload;
    return underlying(model, context, {
      ...options,
      headers: buildCopilotRequestHeaders(context, options?.headers),
      onPayload: (payload, payloadModel) => {
        sanitizeCopilotResponsePayload(payload, { stripEncryptedReasoning });
        return patchOnPayloadResult(
          originalOnPayload?.(payload, payloadModel),
          payload,
          stripEncryptedReasoning,
          sessionKey,
        );
      },
    });
  };
}

export function wrapCopilotOpenAICompletionsStream(
  baseStreamFn: StreamFn | undefined,
): StreamFn | undefined {
  if (!baseStreamFn) {
    return undefined;
  }
  const underlying = baseStreamFn;
  return (model, context, options) => {
    if (model.provider !== "github-copilot" || model.api !== "openai-completions") {
      return underlying(model, context, options);
    }

    return underlying(model, context, {
      ...options,
      headers: buildCopilotRequestHeaders(context, options?.headers),
    });
  };
}

export function wrapCopilotProviderStream(ctx: ProviderWrapStreamFnContext): StreamFn | undefined {
  return wrapCopilotOpenAICompletionsStream(
    wrapCopilotOpenAIResponsesStream(wrapCopilotAnthropicStream(ctx.streamFn)),
  );
}
