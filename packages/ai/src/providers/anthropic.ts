import { Stream } from "@anthropic-ai/sdk/core/streaming.js";
import type { RawMessageStreamEvent } from "@anthropic-ai/sdk/resources/messages.js";
import { getEnvApiKey } from "../env-api-keys.js";
import { getAiTransportHost, resolveAiTransportHeaderSentinels } from "../host.js";
import type { AnthropicContextManagementOptions, AnthropicOptions } from "../provider-options.js";
import {
  isDirectAnthropicModel,
  supportsAnthropicServerSideFallback,
} from "../transports/anthropic-payload-policy.js";
import { runAnthropicStreamLifecycle } from "../transports/anthropic-stream-lifecycle.js";
import { applyAnthropicThinkingOptions } from "../transports/anthropic-transport-options.js";
import { resolveOpencodeSessionHeaders } from "../transports/session-affinity.js";
import { streamFragmentError } from "../transports/transport-utils.js";
import type { Model, SimpleStreamOptions, StreamFunction } from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { parseJsonWithRepair } from "../utils/json-parse.js";
import { notifyLlmRequestActivity } from "../utils/llm-request-activity.js";
import { requireApiKey } from "../utils/required-api-key.js";
import {
  isAnthropicOAuthApiKey,
  omitFoundryBearerCredentialHeaders,
  usesFoundryBearerAuth,
} from "./anthropic-auth-headers.js";
import {
  buildAnthropicClaudeCodeIdentity,
  prepareClaudeNoPrefillRequestContext,
  supportsClaudeAdaptiveThinking,
} from "./anthropic-model-contract.js";
import { resolveCacheRetention } from "./cache-retention.js";
import { resolveCloudflareBaseUrl } from "./cloudflare.js";
import { buildCopilotDynamicHeaders } from "./github-copilot-headers.js";
import { buildBaseOptions, clampMaxTokensToModel } from "./simple-options.js";

type AnthropicCompactionOptions = AnthropicOptions & {
  authProfileId?: string;
};

export type {
  AnthropicEffort,
  AnthropicOptions,
  AnthropicThinkingDisplay,
} from "../provider-options.js";

const FINE_GRAINED_TOOL_STREAMING_BETA = "fine-grained-tool-streaming-2025-05-14";
const INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14";
const ANTHROPIC_MIN_THINKING_BUDGET_TOKENS = 1024;
let anthropicSdkModule: Promise<typeof import("@anthropic-ai/sdk")> | undefined;

function getAnthropicCompat(model: Model<"anthropic-messages">) {
  const isFireworks = model.provider === "fireworks";
  const isCloudflareAiGatewayAnthropic =
    model.provider === "cloudflare-ai-gateway" && model.baseUrl.includes("anthropic");
  return {
    supportsEagerToolInputStreaming: model.compat?.supportsEagerToolInputStreaming ?? !isFireworks,
    sendSessionAffinityHeaders:
      model.compat?.sendSessionAffinityHeaders ?? (isFireworks || isCloudflareAiGatewayAnthropic),
  };
}

const ANTHROPIC_MESSAGE_EVENTS: ReadonlySet<string> = new Set([
  "message_start",
  "message_delta",
  "message_stop",
  "content_block_start",
  "content_block_delta",
  "content_block_stop",
]);

async function* iterateAnthropicEvents(
  response: Response,
  signal?: AbortSignal,
): AsyncGenerator<RawMessageStreamEvent> {
  if (!response.body) {
    throw new Error("Attempted to iterate over an Anthropic response with no body");
  }

  for await (const sse of Stream.rawEvents(response)) {
    if (sse.event === "error") {
      throw new Error(sse.data);
    }

    notifyLlmRequestActivity(signal);
    if (!ANTHROPIC_MESSAGE_EVENTS.has(sse.event ?? "")) {
      continue;
    }

    try {
      const event = parseJsonWithRepair(sse.data) as RawMessageStreamEvent;
      yield event;
    } catch (error) {
      throw streamFragmentError(error);
    }
  }
}

export const streamAnthropic: StreamFunction<"anthropic-messages", AnthropicCompactionOptions> = (
  model,
  context,
  options,
) => {
  const stream = new AssistantMessageEventStream();
  const requestContext = prepareClaudeNoPrefillRequestContext(model, context);
  let requestOptions = options;
  if (options?.thinkingEnabled === true && !supportsClaudeAdaptiveThinking(model)) {
    const budgetTokens = options.thinkingBudgetTokens ?? ANTHROPIC_MIN_THINKING_BUDGET_TOKENS;
    const maxTokens = options.maxTokens ?? model.maxTokens;
    if (!(budgetTokens >= ANTHROPIC_MIN_THINKING_BUDGET_TOKENS && budgetTokens < maxTokens)) {
      // Manual thinking is one request-wide mode: replay, sampling, tool choice,
      // headers, and payload construction must all observe the disabled state.
      requestOptions = { ...options, thinkingEnabled: false, thinkingBudgetTokens: undefined };
    }
  }

  void runAnthropicStreamLifecycle({
    model,
    stream,
    options: requestOptions,
    profile: "provider",
    prepare: async () => {
      let client = requestOptions?.client;
      let isOAuthToken = false;
      let serverSideFallback = false;
      let directApiKeyBetaHeader: string | undefined;
      let claudeCodeVersion: string | undefined;
      // Injected clients own their headers, so they cannot opt into beta-gated fallbacks.
      if (!client) {
        const apiKey = requestOptions?.apiKey ?? getEnvApiKey(model.provider) ?? "";
        const dynamicHeaders =
          model.provider === "github-copilot"
            ? buildCopilotDynamicHeaders(requestContext.messages)
            : undefined;
        const cacheRetention = requestOptions?.cacheRetention ?? resolveCacheRetention();
        const sessionId = cacheRetention === "none" ? undefined : requestOptions?.sessionId;
        const thinkingEnabled = requestOptions?.thinkingEnabled === true;
        const interleavedThinking = requestOptions?.interleavedThinking ?? true;
        const useFineGrainedToolStreamingBeta =
          Boolean(requestContext.tools?.length) &&
          !getAnthropicCompat(model).supportsEagerToolInputStreaming;
        const optionsHeaders = resolveOpencodeSessionHeaders(model, requestOptions);
        // Adaptive thinking models (Opus 4.6, Sonnet 4.6) have interleaved thinking built-in.
        // The beta header is deprecated on Opus 4.6 and redundant on Sonnet 4.6, so skip it.
        const needsInterleavedBeta = interleavedThinking && !supportsClaudeAdaptiveThinking(model);
        const betaFeatures: string[] = [];
        if (useFineGrainedToolStreamingBeta) {
          betaFeatures.push(FINE_GRAINED_TOOL_STREAMING_BETA);
        }
        if (needsInterleavedBeta) {
          betaFeatures.push(INTERLEAVED_THINKING_BETA);
        }
        const fetchOptions =
          /^kimi(?:-|$)/.test(model.provider) && thinkingEnabled
            ? { sanitizeSse: false as const }
            : undefined;
        // Anthropic supports custom fetch, so sentinels stay opaque until guarded egress.
        const clientOptions = {
          baseURL: model.baseUrl,
          dangerouslyAllowBrowser: true,
          fetch: getAiTransportHost().buildModelFetch(model, undefined, fetchOptions),
          maxRetries: 0,
        };
        const baseHeaders = {
          accept: "application/json",
          "anthropic-dangerous-direct-browser-access": "true",
          ...(betaFeatures.length > 0 ? { "anthropic-beta": betaFeatures.join(",") } : {}),
        };
        let configuredApiKey: string | null = apiKey;
        let authToken: string | null = null;
        let defaultHeaders: Record<string, string | null>;
        const isCopilot = model.provider === "github-copilot";
        if (model.provider === "cloudflare-ai-gateway") {
          clientOptions.baseURL = resolveCloudflareBaseUrl(model);
          defaultHeaders = Object.assign(
            {},
            baseHeaders,
            { Authorization: null },
            model.headers,
            optionsHeaders,
          );
        } else if (
          isCopilot ||
          usesFoundryBearerAuth({
            ...model,
            headers: resolveAiTransportHeaderSentinels(model.headers),
          })
        ) {
          configuredApiKey = null;
          authToken = apiKey;
          defaultHeaders = Object.assign(
            {},
            baseHeaders,
            isCopilot ? model.headers : omitFoundryBearerCredentialHeaders(model.headers),
            dynamicHeaders,
            optionsHeaders,
          );
        } else if (isAnthropicOAuthApiKey(apiKey)) {
          const identity = buildAnthropicClaudeCodeIdentity(
            ["claude-code-20250219", "oauth-2025-04-20", ...betaFeatures].join(","),
            model.headers,
            optionsHeaders,
          );
          configuredApiKey = null;
          authToken = apiKey;
          defaultHeaders = identity.headers;
          isOAuthToken = true;
          claudeCodeVersion = identity.version;
        } else {
          serverSideFallback =
            model.provider === "anthropic" && supportsAnthropicServerSideFallback(model);
          defaultHeaders = Object.assign(
            {},
            baseHeaders,
            sessionId && getAnthropicCompat(model).sendSessionAffinityHeaders
              ? { "x-session-affinity": sessionId }
              : {},
            model.headers,
            optionsHeaders,
          );
          // Binding controls are verified only on direct API-key requests, not OAuth or proxies.
          if (isDirectAnthropicModel(model)) {
            directApiKeyBetaHeader =
              Object.entries(defaultHeaders).findLast(
                ([name]) => name.toLowerCase() === "anthropic-beta",
              )?.[1] ?? "";
          }
        }
        const { default: Anthropic } = await (anthropicSdkModule ??= import("@anthropic-ai/sdk"));
        client = new Anthropic({
          ...clientOptions,
          apiKey: configuredApiKey,
          authToken,
          defaultHeaders,
        });
      }
      return {
        isOAuthToken,
        serverSideFallback,
        directApiKeyBetaHeader,
        claudeCodeVersion,
        context: requestContext,
        options: requestOptions,
        request: async (body, headers) => {
          const response = await client.messages
            .create(body, {
              ...(requestOptions?.signal ? { signal: requestOptions.signal } : {}),
              ...(requestOptions?.timeoutMs !== undefined
                ? { timeout: requestOptions.timeoutMs }
                : {}),
              maxRetries: 0,
              headers,
            })
            .asResponse();
          return { response, events: iterateAnthropicEvents(response, requestOptions?.signal) };
        },
      };
    },
  });

  return stream;
};

export const streamSimpleAnthropic: StreamFunction<
  "anthropic-messages",
  SimpleStreamOptions &
    AnthropicContextManagementOptions & {
      authProfileId?: string;
      toolChoice?: AnthropicCompactionOptions["toolChoice"];
      thinkingDisplay?: AnthropicOptions["thinkingDisplay"];
    }
> = (model, context, options) => {
  const apiKey = requireApiKey(model.provider, options?.apiKey);

  const base = {
    ...buildBaseOptions(model, options, apiKey),
    anthropicServerCompaction: options?.anthropicServerCompaction,
    anthropicCompactThreshold: options?.anthropicCompactThreshold,
    cacheTtlPruning: options?.cacheTtlPruning,
    onCompactionRejected: options?.onCompactionRejected,
    authProfileId: options?.authProfileId,
    maxTokens: clampMaxTokensToModel(model, options?.maxTokens ?? model.maxTokens),
    toolChoice: options?.toolChoice,
    thinkingDisplay: options?.thinkingDisplay,
  };
  applyAnthropicThinkingOptions(model, base, options, "provider");
  return streamAnthropic(model, context, base);
};
