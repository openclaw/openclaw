import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import { getEnvApiKey } from "../env-api-keys.js";
import type { BaseOpenAIStreamOptions } from "../provider-options.js";
import { resolveOpenAICompletionsCompat } from "../transports/openai-completions-compat.js";
import type { OpenAIResponsesRequestParams } from "../transports/openai-responses-contracts.js";
import { resolveProviderSimpleCompletionHeaders } from "../transports/provider-transport-turn-state.js";
import type { Model, SimpleStreamOptions, StreamFunction } from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { requireApiKey } from "../utils/required-api-key.js";
import { resolveCacheRetention } from "./cache-retention.js";
import { buildCopilotDynamicHeaders } from "./github-copilot-headers.js";
import {
  clampOpenAIPromptCacheKey,
  resolveOpenAIPromptCacheParams,
} from "./openai-prompt-cache.js";
import { createOpenAIProviderClient } from "./openai-provider-client.js";
import {
  resolveOpenAISimpleReasoningEffort,
  type OpenAIRequestReasoningEffort,
} from "./openai-request-reasoning.js";
import {
  applyCommonResponsesParams,
  applyResponsesServiceTierPricing,
  convertResponsesMessages,
  createResponsesAssistantOutput,
  runResponsesStreamLifecycle,
} from "./openai-responses-shared.js";
import { buildBaseOptions } from "./simple-options.js";

const OPENAI_TOOL_CALL_PROVIDERS = new Set(["openai", "opencode"]);

function getCompat(model: Model<"openai-responses">) {
  return {
    ...resolveOpenAICompletionsCompat(model),
    sendSessionIdHeader: model.compat?.sendSessionIdHeader ?? true,
  };
}

export interface OpenAIResponsesOptions extends BaseOpenAIStreamOptions {
  reasoningEffort?: OpenAIRequestReasoningEffort;
  reasoningSummary?: "auto" | "detailed" | "concise" | null;
  replayResponsesItemIds?: boolean;
  serviceTier?: ResponseCreateParamsStreaming["service_tier"];
}

type OpenAIResponsesReplayOptions = SimpleStreamOptions & {
  authProfileId?: string;
  replayResponsesItemIds?: boolean;
} & Pick<
    BaseOpenAIStreamOptions,
    "openclawCodeModeToolSurface" | "openclawCodeModeAllowedHostedToolTypes"
  >;

export const streamOpenAIResponses: StreamFunction<"openai-responses", OpenAIResponsesOptions> = (
  model,
  context,
  options,
) => {
  const stream = new AssistantMessageEventStream();
  const output = createResponsesAssistantOutput(model);

  void runResponsesStreamLifecycle({
    stream,
    model,
    output,
    context,
    options,
    createClient: () => {
      const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
      const cacheRetention = resolveCacheRetention(options?.cacheRetention);
      const cacheSessionId = cacheRetention === "none" ? undefined : options?.sessionId;
      if (!apiKey) {
        throw new Error(`No API key for provider: ${model.provider}`);
      }

      const compat = getCompat(model);
      const headers = { ...model.headers };
      if (model.provider === "github-copilot") {
        Object.assign(headers, buildCopilotDynamicHeaders(context.messages));
      }

      if (cacheSessionId) {
        if (compat.sendSessionIdHeader) {
          headers.session_id = cacheSessionId;
        }
        headers["x-client-request-id"] = cacheSessionId;
      }

      return createOpenAIProviderClient(
        model,
        apiKey,
        headers,
        resolveProviderSimpleCompletionHeaders(model, options),
        options?.onResponse,
      );
    },
    buildParams: (_requestModel, replayMode) => {
      const messages = convertResponsesMessages(model, context, OPENAI_TOOL_CALL_PROVIDERS, {
        replayResponsesItemIds: options?.replayResponsesItemIds ?? false,
        sessionId: options?.sessionId,
        authProfileId: options?.authProfileId,
        mutableInput: Boolean(options?.onPayload),
        replayMode,
      });

      const cacheRetention = resolveCacheRetention(options?.cacheRetention);
      const compat = getCompat(model);
      // The API supports 12h before the pinned SDK exposes that TTL. Keep other SDK fields strict.
      const params: Omit<ResponseCreateParamsStreaming, "prompt_cache_options"> &
        OpenAIResponsesRequestParams = {
        model: model.id,
        input: messages,
        stream: true,
        prompt_cache_key:
          cacheRetention === "none" || !compat.supportsPromptCacheKey
            ? undefined
            : clampOpenAIPromptCacheKey(options?.promptCacheKey ?? options?.sessionId),
        ...resolveOpenAIPromptCacheParams(model, cacheRetention, compat, options?.promptCacheTtl),
        store: false,
      };

      if (options?.serviceTier !== undefined) {
        params.service_tier = options.serviceTier;
      }

      applyCommonResponsesParams(params, model, context, options, {
        setDefaultReasoningOff: model.provider !== "github-copilot",
      });

      return params;
    },
    processStreamOptions: {
      serviceTier: options?.serviceTier,
      applyServiceTierPricing: (usage, serviceTier) =>
        applyResponsesServiceTierPricing(usage, serviceTier, model),
    },
  });

  return stream;
};

export const streamSimpleOpenAIResponses: StreamFunction<
  "openai-responses",
  SimpleStreamOptions
> = (model, context, options) => {
  const apiKey = requireApiKey(model.provider, options?.apiKey);

  const base = buildBaseOptions(model, options, apiKey);
  const replayOptions = options as OpenAIResponsesReplayOptions | undefined;

  return streamOpenAIResponses(model, context, {
    ...base,
    authProfileId: replayOptions?.authProfileId,
    openclawCodeModeToolSurface: replayOptions?.openclawCodeModeToolSurface,
    openclawCodeModeAllowedHostedToolTypes: replayOptions?.openclawCodeModeAllowedHostedToolTypes,
    reasoningEffort: resolveOpenAISimpleReasoningEffort(model, options?.reasoning),
    replayResponsesItemIds: replayOptions?.replayResponsesItemIds,
  } satisfies OpenAIResponsesOptions);
};
