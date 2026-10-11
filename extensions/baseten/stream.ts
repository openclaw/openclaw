/** Baseten session affinity and model-specific thinking policy. */
import { streamSimple } from "openclaw/plugin-sdk/llm";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  normalizeOpenAICompatibleReasoningReplay,
  streamWithPayloadPatch,
} from "openclaw/plugin-sdk/provider-stream-shared";
import { asNonArrayRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { BASETEN_BASE_URL, usesBasetenChatTemplateThinking } from "./models.js";

export function createBasetenThinkingWrapper(
  ctx: ProviderWrapStreamFnContext,
): ProviderWrapStreamFnContext["streamFn"] {
  const underlying = ctx.streamFn ?? streamSimple;
  return (model, context, options) => {
    // Standalone completions use dispatch aliases; the source API owns wire policy.
    if (model.provider !== "baseten" || (ctx.sourceApi ?? model.api) !== "openai-completions") {
      return underlying(model, context, options);
    }
    const affinity = options?.promptCacheKey ?? options?.sessionId;
    const cacheRetention = options?.cacheRetention ?? ctx.extraParams?.cacheRetention;
    let streamOptions = options;
    if (
      affinity &&
      cacheRetention !== "none" &&
      model.baseUrl?.trim().replace(/\/+$/u, "") === BASETEN_BASE_URL &&
      !Object.keys({ ...model.headers, ...options?.headers }).some(
        (name) => name.toLowerCase() === "x-session-affinity",
      )
    ) {
      streamOptions = {
        ...options,
        headers: { ...options?.headers, "x-session-affinity": affinity },
      };
    }
    const optIn = usesBasetenChatTemplateThinking(model.id);
    const thinkingLevel =
      options?.reasoning ??
      (ctx.thinkingLevel === "adaptive" ? "max" : ctx.thinkingLevel) ??
      (optIn ? "off" : undefined);
    // Resolve before serialization so scalar effort agrees with the opt-in toggle.
    return streamWithPayloadPatch(
      underlying,
      model,
      context,
      thinkingLevel === undefined ? streamOptions : { ...streamOptions, reasoning: thinkingLevel },
      (payload) => {
        const normalizedModelId = model.id.trim().toLowerCase();
        if (
          normalizedModelId === "deepseek-ai/deepseek-v4-pro" ||
          normalizedModelId === "deepseek-ai/deepseek-v4-pro-0813"
        ) {
          // DeepSeek defaults on; only explicit off may remove required replay metadata.
          normalizeOpenAICompatibleReasoningReplay(payload, {
            thinkingEnabled: thinkingLevel !== "off",
            stripAssistantMessagesOnly: true,
            replaceNullReasoningContent: true,
          });
          // The current Pro endpoint requires this envelope whenever scalar effort is present.
          if (
            normalizedModelId === "deepseek-ai/deepseek-v4-pro-0813" &&
            payload.reasoning_effort !== undefined
          ) {
            payload.thinking = { type: "enabled" };
          }
        }
        if (optIn) {
          payload.chat_template_args = {
            ...asNonArrayRecord(payload.chat_template_args),
            enable_thinking: thinkingLevel !== "off",
          };
        }
      },
    );
  };
}
