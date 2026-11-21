import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { isGoogleGemini3ThinkingLevelModel } from "../internal/google-model-family.js";
import type { ProviderModel } from "../provider-types.js";
import type { AssistantMessage } from "../types.js";
import {
  detectOpenAICompletionsCompat,
  isNativeOpenAIEndpoint,
} from "./openai-completions-compat.js";
import { requiresReasoningContentReplay } from "./openai-completions-reasoning-replay.js";
import {
  GEMINI_THOUGHT_SIGNATURE_VALIDATOR_SKIP,
  type OpenAIModeModel,
} from "./openai-transport-shared.js";

const GOOGLE_COMPAT_THOUGHT_SIGNATURE_ELLIPSIS_RE = /[\u2026]|\.\.\./;
const GOOGLE_COMPAT_THOUGHT_SIGNATURE_BASE64_RE = /^[A-Za-z0-9+/=]+$/;

function hasGoogleCompatThoughtSignatureTruncationFootprint(value: string): boolean {
  return (
    GOOGLE_COMPAT_THOUGHT_SIGNATURE_ELLIPSIS_RE.test(value) ||
    (GOOGLE_COMPAT_THOUGHT_SIGNATURE_BASE64_RE.test(value) && value.length % 4 !== 0)
  );
}

// Resolve against the exact source occurrence, before IDs can alias another turn.
export function toolCallThoughtSignatureReplay(
  model: Pick<ProviderModel, "api" | "provider" | "id" | "baseUrl" | "reasoning" | "compat">,
  message: Pick<AssistantMessage, "api" | "provider" | "model">,
  thoughtSignature: string | undefined,
) {
  const endpointClass = detectOpenAICompletionsCompat(model).capabilities.endpointClass;
  const google =
    model.provider === "google" ||
    endpointClass === "google-generative-ai" ||
    endpointClass === "google-vertex";
  const fallback =
    google && isGoogleGemini3ThinkingLevelModel(model.id)
      ? GEMINI_THOUGHT_SIGNATURE_VALIDATOR_SKIP
      : undefined;
  const sameRoute =
    message.api === model.api && message.provider === model.provider && message.model === model.id;
  let signature = sameRoute ? thoughtSignature : undefined;
  // Encrypted reasoning details (JSON) replay through reasoning_details instead.
  if (!google && signature?.trimStart().startsWith("{")) {
    signature = undefined;
  }
  signature ||= fallback;
  if (signature && hasGoogleCompatThoughtSignatureTruncationFootprint(signature.trim())) {
    signature = fallback;
  }
  if (!signature) {
    return undefined;
  }
  // Compatible proxies get only signatures issued on this route; adapters may move them.
  return google
    ? { extra_content: { google: { thought_signature: signature } } }
    : { provider_specific_fields: { thought_signature: signature } };
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
  model: OpenAIModeModel,
  compat: {
    requiresReasoningContentOnAssistantMessages: boolean;
    thinkingFormat: string;
  },
): void {
  const preserveOpenRouterReasoning =
    compat.thinkingFormat === "openrouter" && shouldPreserveOpenRouterReasoningReplay(model);
  const preserveReasoningContent =
    compat.requiresReasoningContentOnAssistantMessages ||
    compat.thinkingFormat === "deepseek" ||
    compat.thinkingFormat === "zai" ||
    (model.reasoning &&
      !isNativeOpenAIEndpoint(model) &&
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
