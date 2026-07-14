// Github Copilot plugin module implements stream behavior.
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { Context } from "openclaw/plugin-sdk/llm";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { buildCopilotIdeHeaders, COPILOT_INTEGRATION_ID } from "openclaw/plugin-sdk/provider-auth";
import {
  applyAnthropicEphemeralCacheControlMarkers,
  streamWithPayloadPatch,
} from "openclaw/plugin-sdk/provider-stream-shared";
import {
  collectCopilotResponseReasoningFingerprints,
  type CopilotReasoningFingerprintCounts,
  sanitizeCopilotResponsePayload,
} from "./connection-bound-ids.js";
import { stripCopilotAssistantThinkingMessages } from "./replay-policy.js";

type StreamOptions = Parameters<StreamFn>[2];
type CopilotResponsesStreamOptions = StreamOptions & {
  onEncryptedReplayRejected?: (request: unknown) => void;
};
type RejectedReasoningState = {
  fingerprints: Set<string>;
  rejectAll: boolean;
};
const MAX_REJECTED_REASONING_SESSIONS = 32;
const MAX_REJECTED_REASONING_PER_SESSION = 128;

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
  approvedReasoning: CopilotReasoningFingerprintCounts,
  rejectedState: RejectedReasoningState | undefined,
): unknown {
  if (result && typeof result === "object" && "then" in result) {
    return Promise.resolve(result).then((next) => {
      sanitizeCopilotResponsePayload(next === undefined ? originalPayload : next, {
        approvedReasoning,
        ...(rejectedState
          ? {
              rejectedReasoning: rejectedState.fingerprints,
              rejectAllReasoning: rejectedState.rejectAll,
            }
          : {}),
      });
      return next;
    });
  }
  sanitizeCopilotResponsePayload(result === undefined ? originalPayload : result, {
    approvedReasoning,
    ...(rejectedState
      ? {
          rejectedReasoning: rejectedState.fingerprints,
          rejectAllReasoning: rejectedState.rejectAll,
        }
      : {}),
  });
  return result;
}

function getOrCreateRejectedReasoning(
  rejectedBySession: Map<string, RejectedReasoningState>,
  sessionKey: string,
): RejectedReasoningState {
  const existing = rejectedBySession.get(sessionKey);
  if (existing) {
    return existing;
  }
  if (rejectedBySession.size >= MAX_REJECTED_REASONING_SESSIONS) {
    const oldest = rejectedBySession.keys().next().value;
    if (oldest !== undefined) {
      rejectedBySession.delete(oldest);
    }
  }
  const created: RejectedReasoningState = {
    fingerprints: new Set<string>(),
    rejectAll: false,
  };
  rejectedBySession.set(sessionKey, created);
  return created;
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
  const rejectedBySession = new Map<string, RejectedReasoningState>();
  return (model, context, options) => {
    if (model.provider !== "github-copilot" || model.api !== "openai-responses") {
      return underlying(model, context, options);
    }

    const copilotOptions = options as CopilotResponsesStreamOptions | undefined;
    const sessionKey = copilotOptions?.sessionId?.trim() || "__unknown__";
    if (inferCopilotInitiator(context.messages) === "user") {
      rejectedBySession.delete(sessionKey);
    }
    const rejectedState = rejectedBySession.get(sessionKey);
    const originalOnPayload = copilotOptions?.onPayload;
    const originalOnEncryptedReplayRejected = copilotOptions?.onEncryptedReplayRejected;
    const wrappedOptions: CopilotResponsesStreamOptions = {
      ...options,
      headers: buildCopilotRequestHeaders(context, options?.headers),
      onPayload: (payload, payloadModel) => {
        if (rejectedState && !rejectedState.rejectAll) {
          const present = collectCopilotResponseReasoningFingerprints(payload);
          for (const fingerprint of rejectedState.fingerprints) {
            if (!present.has(fingerprint)) {
              rejectedState.fingerprints.delete(fingerprint);
            }
          }
        }
        const { reasoningFingerprints } = sanitizeCopilotResponsePayload(
          payload,
          rejectedState
            ? {
                rejectedReasoning: rejectedState.fingerprints,
                rejectAllReasoning: rejectedState.rejectAll,
              }
            : undefined,
        );
        return patchOnPayloadResult(
          originalOnPayload?.(payload, payloadModel),
          payload,
          reasoningFingerprints,
          rejectedState,
        );
      },
      onEncryptedReplayRejected: (request) => {
        const sessionRejectedState = getOrCreateRejectedReasoning(rejectedBySession, sessionKey);
        if (!sessionRejectedState.rejectAll) {
          for (const fingerprint of collectCopilotResponseReasoningFingerprints(request)) {
            if (sessionRejectedState.fingerprints.size >= MAX_REJECTED_REASONING_PER_SESSION) {
              sessionRejectedState.fingerprints.clear();
              sessionRejectedState.rejectAll = true;
              break;
            }
            sessionRejectedState.fingerprints.add(fingerprint);
          }
        }
        originalOnEncryptedReplayRejected?.(request);
      },
    };
    return underlying(model, context, wrappedOptions);
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
