import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import {
  resolveOpenAIRequestReasoning,
  streamSimple,
  type Context,
  type Model,
} from "openclaw/plugin-sdk/llm";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  createOpenAICompatibleCompletionsThinkingOffWrapper,
  createPlainTextToolCallCompatWrapper,
  streamWithPayloadPatch,
} from "openclaw/plugin-sdk/provider-stream-shared";
import { stripUnsupportedSchemaKeywords } from "openclaw/plugin-sdk/provider-tools";
import { asRecord, filterStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveLmstudioServerBase } from "./models.js";

export type LmstudioStreamOptions = NonNullable<Parameters<StreamFn>[2]> & {
  // Keep provider-level adaptive intent until the binary request mapping.
  lmstudioThinkingLevel?: ProviderWrapStreamFnContext["thinkingLevel"];
};

function projectLmstudioHistory(context: Context, model: Model): Context {
  return {
    ...context,
    messages: context.messages.map((message) => {
      if (
        message.role !== "assistant" ||
        message.provider !== model.provider ||
        message.model !== model.id ||
        message.api === model.api ||
        (message.api !== "openai-completions" && message.api !== "anthropic-messages")
      ) {
        return message;
      }
      // Both APIs serve the same model. Preserve separate reasoning on an API
      // switch instead of letting generic cross-model replay turn it into text.
      return {
        ...message,
        api: model.api,
        content: message.content
          .filter((block) => block.type !== "thinking" || !block.redacted)
          .map((block) =>
            block.type === "thinking" ? { ...block, thinkingSignature: undefined } : block,
          ),
      };
    }),
  };
}

export function createLmstudioChatStream(): StreamFn {
  const underlying = streamSimple;
  const completions = createPlainTextToolCallCompatWrapper(underlying);
  return (model, context, options?: LmstudioStreamOptions) => {
    const { lmstudioThinkingLevel, ...streamOptions } = options ?? {};
    const requestedThinking = streamOptions.reasoning ?? lmstudioThinkingLevel;
    const api = model.api;
    if (api !== "openai-completions" && api !== "anthropic-messages") {
      return underlying(model, context, streamOptions);
    }
    // Messages silently ignores response schemas. Select the enforcing transport
    // before sending anything, rather than retrying a potentially effectful turn.
    if (streamOptions.responseFormat) {
      const completionsModel = {
        ...model,
        api: "openai-completions" as const,
        compat: {
          ...model.compat,
          supportsJsonSchemaResponseFormat:
            asRecord(model.compat).supportsJsonSchemaResponseFormat !== false,
        },
      };
      return createOpenAICompatibleCompletionsThinkingOffWrapper(completions, requestedThinking)(
        completionsModel,
        projectLmstudioHistory(context, completionsModel),
        streamOptions,
      );
    }
    const thinkingEnabled =
      requestedThinking === undefined
        ? undefined
        : resolveOpenAIRequestReasoning(model, requestedThinking).thinkingEnabled;
    const unsupported = new Set(
      filterStringEntries(asRecord(model.compat).unsupportedToolSchemaKeywords),
    );
    const messagesModel = {
      ...model,
      api: "anthropic-messages" as const,
      baseUrl: resolveLmstudioServerBase(model.baseUrl),
      compat: { allowEmptySignature: true, supportsCacheControlOnTools: false },
    };
    return streamWithPayloadPatch(
      underlying,
      messagesModel,
      projectLmstudioHistory(context, messagesModel),
      {
        ...streamOptions,
        // Shared replay and sampling must see the mapped binary mode too.
        reasoning: thinkingEnabled === undefined ? undefined : thinkingEnabled ? "low" : "off",
        cacheRetention: "none",
      },
      (payload) => {
        // Binary thinking has no separate token budget; keep the caller's output cap.
        payload.max_tokens = Math.min(
          streamOptions.maxTokens ?? model.maxTokens,
          model.maxTokens,
          typeof payload.max_tokens === "number" ? payload.max_tokens : Number.POSITIVE_INFINITY,
        );
        if (Array.isArray(payload.tools)) {
          for (const tool of payload.tools) {
            const definition = asRecord(tool);
            definition.input_schema = stripUnsupportedSchemaKeywords(
              definition.input_schema,
              unsupported,
            );
          }
        }
        if (thinkingEnabled !== undefined) {
          // LM Studio uses a binary switch; Anthropic's minimum budget must not
          // disable an explicitly enabled request with a small output cap.
          payload.thinking = thinkingEnabled
            ? { type: "enabled", budget_tokens: 1024 }
            : { type: "disabled" };
        } else {
          delete payload.thinking;
        }
      },
    );
  };
}
