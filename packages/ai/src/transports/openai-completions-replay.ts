import type { Model } from "@openclaw/llm-core";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { isGoogleGemini3ThinkingLevelModel } from "../internal/google-model-family.js";
import type { ProviderContext } from "../provider-types.js";
import { detectOpenAICompletionsCompat } from "./openai-completions-compat.js";
import { requiresReasoningContentReplay } from "./openai-completions-reasoning-replay.js";
import {
  GEMINI_THOUGHT_SIGNATURE_VALIDATOR_SKIP,
  type OpenAIModeModel,
} from "./openai-transport-shared.js";

function isGoogleOpenAICompatModel(model: OpenAIModeModel): boolean {
  const endpointClass = detectOpenAICompletionsCompat(model as Model<"openai-completions">)
    .capabilities.endpointClass;
  return (
    model.provider === "google" ||
    endpointClass === "google-generative-ai" ||
    endpointClass === "google-vertex"
  );
}

const GOOGLE_COMPAT_THOUGHT_SIGNATURE_ELLIPSIS_RE = /[\u2026]|\.\.\./;
const GOOGLE_COMPAT_THOUGHT_SIGNATURE_BASE64_RE = /^[A-Za-z0-9+/=]+$/;

function hasGoogleCompatThoughtSignatureTruncationFootprint(value: string): boolean {
  return (
    GOOGLE_COMPAT_THOUGHT_SIGNATURE_ELLIPSIS_RE.test(value) ||
    (GOOGLE_COMPAT_THOUGHT_SIGNATURE_BASE64_RE.test(value) && value.length % 4 !== 0)
  );
}

function injectToolCallThoughtSignatures(
  outgoingMessages: ChatCompletionMessageParam[],
  context: ProviderContext,
  model: OpenAIModeModel,
): void {
  // Other compatible endpoints (for example LiteLLM in front of Gemini) receive back
  // only the signatures they issued on this route, in the field they used.
  const google = isGoogleOpenAICompatModel(model);
  const sigById = new Map<string, string>();
  const fallbackSig =
    google && isGoogleGemini3ThinkingLevelModel(model.id)
      ? GEMINI_THOUGHT_SIGNATURE_VALIDATOR_SKIP
      : undefined;
  for (const msg of context.messages ?? []) {
    if (msg.role !== "assistant") {
      continue;
    }
    if (!Array.isArray(msg.content)) {
      continue;
    }
    for (const block of msg.content) {
      if (block.type !== "toolCall") {
        continue;
      }
      const id = block.id;
      const sig = block.thoughtSignature;
      if (typeof id === "string" && typeof sig === "string" && sig.length > 0) {
        const isSameRoute =
          msg.api === model.api && msg.provider === model.provider && msg.model === model.id;
        // Encrypted reasoning details (JSON) replay through reasoning_details instead.
        if ((!isSameRoute && !fallbackSig) || (!google && sig.trimStart().startsWith("{"))) {
          continue;
        }
        sigById.set(id, isSameRoute ? sig : (fallbackSig ?? sig));
      }
    }
  }
  if (sigById.size === 0 && !fallbackSig) {
    return;
  }
  for (const message of outgoingMessages) {
    const toolCalls = "tool_calls" in message ? message.tool_calls : undefined;
    if (!Array.isArray(toolCalls)) {
      continue;
    }
    for (const toolCall of toolCalls) {
      let sig = sigById.get(toolCall.id) ?? fallbackSig;
      if (sig) {
        const trimmed = sig.trim();
        if (hasGoogleCompatThoughtSignatureTruncationFootprint(trimmed)) {
          sig = fallbackSig;
        }
      }
      if (!sig) {
        continue;
      }
      Object.assign(
        toolCall,
        google
          ? { extra_content: { google: { thought_signature: sig } } }
          : { provider_specific_fields: { thought_signature: sig } },
      );
    }
  }
}

export const COMPLETIONS_REASONING_REPLAY_FIELDS = [
  "reasoning_details",
  "reasoning_content",
  "reasoning",
  "reasoning_text",
] as const;

type ReasoningReplayMessage = { role: "assistant" } & Partial<
  Record<(typeof COMPLETIONS_REASONING_REPLAY_FIELDS)[number], unknown>
>;

function sanitizeOpenRouterReasoningReplayFields(record: ReasoningReplayMessage): void {
  const reasoningDetails = record.reasoning_details;
  if (typeof reasoningDetails === "string") {
    if (reasoningDetails.length > 0 && typeof record.reasoning !== "string") {
      record.reasoning = reasoningDetails;
    }
    delete record.reasoning_details;
  } else if (reasoningDetails !== undefined && !Array.isArray(reasoningDetails)) {
    delete record.reasoning_details;
  }

  // Empty reasoning artifacts are rejected by OpenRouter/DeepSeek replay.
  for (const field of ["reasoning", "reasoning_content"] as const) {
    if (field in record && (typeof record[field] !== "string" || record[field] === "")) {
      delete record[field];
    }
  }

  const reasoningText = record.reasoning_text;
  if (
    typeof reasoningText === "string" &&
    reasoningText.length > 0 &&
    typeof record.reasoning !== "string" &&
    typeof record.reasoning_content !== "string"
  ) {
    record.reasoning = reasoningText;
  }
  delete record.reasoning_text;
}

function shouldPreserveOpenRouterReasoningReplay(model: OpenAIModeModel): boolean {
  if (model.provider !== "openrouter") {
    return true;
  }
  const normalizedModelId = model.id.trim().toLowerCase();
  return !(normalizedModelId.startsWith("anthropic/") || normalizedModelId.startsWith("x-ai/"));
}

// OpenAI Chat Completions assistant-message input does not define reasoning
// replay fields, while OpenRouter and DeepSeek-style providers document
// compatible pass-back contracts. Keep valid provider-owned replay fields, but
// strip them for stock OpenAI before a follow-up request hits the wire.
export function applyCompletionsReplay(
  outgoingMessages: ChatCompletionMessageParam[],
  context: ProviderContext,
  model: OpenAIModeModel,
  compat: {
    requiresReasoningContentOnAssistantMessages: boolean;
    thinkingFormat: string;
  },
): void {
  injectToolCallThoughtSignatures(outgoingMessages, context, model);
  const preserveOpenRouterReasoning =
    compat.thinkingFormat === "openrouter" && shouldPreserveOpenRouterReasoningReplay(model);
  const preserveReasoningContent =
    compat.requiresReasoningContentOnAssistantMessages ||
    compat.thinkingFormat === "deepseek" ||
    compat.thinkingFormat === "zai" ||
    (model.reasoning &&
      model.provider.trim().toLowerCase() !== "openai" &&
      shouldPreserveOpenRouterReasoningReplay(model)) ||
    requiresReasoningContentReplay(model.id);
  for (const message of outgoingMessages) {
    if (message.role !== "assistant") {
      continue;
    }
    if (preserveOpenRouterReasoning) {
      sanitizeOpenRouterReasoningReplayFields(message);
    } else {
      const record: ReasoningReplayMessage = message;
      const requiresReasoningContent =
        model.compat?.requiresReasoningContentOnAssistantMessages === true;
      if (preserveReasoningContent && requiresReasoningContent) {
        // Only an explicit endpoint contract overrides the server's emitted field name.
        for (const field of ["reasoning_content", "reasoning", "reasoning_text"] as const) {
          if (typeof record[field] === "string" && record[field].length > 0) {
            record.reasoning_content = record[field];
            break;
          }
        }
      }
      for (const field of COMPLETIONS_REASONING_REPLAY_FIELDS) {
        if (
          preserveReasoningContent &&
          field !== "reasoning_details" &&
          (!requiresReasoningContent || field === "reasoning_content") &&
          typeof record[field] === "string"
        ) {
          continue;
        }
        delete record[field];
      }
    }
  }
}
