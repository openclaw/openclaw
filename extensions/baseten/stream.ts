/** Baseten request payload policy for models with opt-in chat-template reasoning. */
import { streamSimple } from "openclaw/plugin-sdk/llm";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  normalizeOpenAICompatibleReasoningReplay,
  streamWithPayloadPatch,
} from "openclaw/plugin-sdk/provider-stream-shared";
import { asNonArrayRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { usesBasetenChatTemplateThinking } from "./models.js";

/** Adds Baseten's `chat_template_args.enable_thinking` without dropping caller args. */
export function createBasetenThinkingWrapper(
  ctx: ProviderWrapStreamFnContext,
): ProviderWrapStreamFnContext["streamFn"] {
  const underlying = ctx.streamFn ?? streamSimple;
  return (model, context, options) => {
    // Standalone completions use dispatch aliases; the source API owns wire policy.
    if (model.provider !== "baseten" || (ctx.sourceApi ?? model.api) !== "openai-completions") {
      return underlying(model, context, options);
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
      thinkingLevel === undefined ? options : { ...options, reasoning: thinkingLevel },
      (payload) => {
        if (model.id.trim().toLowerCase() === "deepseek-ai/deepseek-v4-pro") {
          // DeepSeek defaults on; only explicit off may remove required replay metadata.
          normalizeOpenAICompatibleReasoningReplay(payload, {
            thinkingEnabled: thinkingLevel !== "off",
            stripAssistantMessagesOnly: true,
            replaceNullReasoningContent: true,
          });
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
