import type { CacheRetention, Context, Model } from "@openclaw/llm-core";
import { asPositiveFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { getAiTransportHost } from "../host.js";
import { convertMessages, hasToolCallHistory } from "../openai-completions-messages.js";
import type { OpenAICompletionsOptions } from "../provider-options.js";
import { resolveCacheRetention } from "../providers/cache-retention.js";
import { resolveOpenAIPromptCacheParams } from "../providers/openai-prompt-cache.js";
import {
  isOpenAIGpt54MiniModel,
  isOpenAIGpt55Model,
  isOpenAIGpt56Model,
} from "../providers/openai-reasoning-effort.js";
import {
  resolveOpenAIRequestReasoning,
  resolveOpenAISimpleReasoningEffort,
} from "../providers/openai-request-reasoning.js";
import {
  resolveOpenAICompletionsResponseFormat,
  shouldOmitOllamaCompatResponseFormat,
} from "../providers/openai-response-format.js";
import {
  projectOpenAITools,
  prepareOpenAITools,
  reconcileOpenAICompletionsToolChoice,
} from "../providers/openai-tool-projection.js";
import { normalizeOpenAIStrictToolParameters } from "../providers/openai-tool-schema.js";
import { withPreparedToolSchemaNormalization } from "../providers/tool-schema-normalization-cache.js";
import { resolveProviderEndpoint } from "./host-policy.js";
import { resolveMaxTokensParam } from "./model-max-tokens-params.js";
import { emitModelTransportDebug } from "./model-transport-debug.js";
import {
  applyCompletionsAnthropicCacheControl,
  resolveCompletionsCacheControl,
} from "./openai-completions-cache-control.js";
import {
  detectOpenAICompletionsCompat,
  isNativeOpenAIEndpoint,
  type ResolvedOpenAICompletionsCompat,
} from "./openai-completions-compat.js";
import { isAzureOpenAICompatibleHost } from "./openai-completions-host.js";
import { applyCompletionsReasoningAndRouting } from "./openai-completions-policy.js";
import {
  applyCompletionsReplay,
  COMPLETIONS_REASONING_REPLAY_FIELDS,
} from "./openai-completions-replay.js";
import {
  flattenCompletionMessagesToStringContent,
  stripCompletionMessagesToRoleContent,
} from "./openai-completions-string-content.js";
import {
  getCompat,
  resolveOpenAIStrictToolFlagWithDiagnostics,
} from "./openai-transport-params.js";
import {
  log,
  resolvePromptCacheKey,
  sortTransportToolsByName,
  type OpenAIModeModel,
} from "./openai-transport-shared.js";
import {
  CHARS_PER_TOKEN_ESTIMATE,
  estimateStringChars,
  supportsModelTools,
} from "./transport-utils.js";

function isKnownOpenAICompletionsEndpoint(model: Pick<Model, "baseUrl">): boolean {
  if (!model.baseUrl.trim() || isNativeOpenAIEndpoint(model)) {
    return true;
  }
  const endpointClass = resolveProviderEndpoint(model).endpointClass;
  if (endpointClass === "openai-public" || endpointClass === "azure-openai") {
    return true;
  }
  const endpoint = URL.parse(model.baseUrl);
  return endpoint !== null && isAzureOpenAICompatibleHost(endpoint.hostname.toLowerCase());
}

function resolveOpenAICompletionsMaxTokens(
  model: OpenAIModeModel,
  options: OpenAICompletionsOptions | undefined,
): { maxTokens: number | undefined; clampToModelMaxTokens: boolean } {
  if (options?.maxTokens) {
    return { maxTokens: options.maxTokens, clampToModelMaxTokens: true };
  }
  const paramsMaxTokens = resolveMaxTokensParam(
    (model as { params?: Record<string, unknown> }).params,
  );
  if (paramsMaxTokens) {
    return { maxTokens: paramsMaxTokens, clampToModelMaxTokens: false };
  }
  return { maxTokens: model.maxTokens, clampToModelMaxTokens: false };
}

function resolveOpenAICompletionsModelMaxTokens(model: OpenAIModeModel): number | undefined {
  const maxTokens = asPositiveFiniteNumber(model.maxTokens);
  return maxTokens === undefined ? undefined : Math.floor(maxTokens);
}

const OPENAI_COMPLETIONS_INPUT_TOKEN_SAFETY_MARGIN = 1.25;
const OPENAI_COMPLETIONS_IMAGE_CHAR_ESTIMATE = 8_000;
const MIN_USEFUL_OUTPUT_TOKENS = 16;

function estimateJsonChars(value: unknown, fallback: number): number {
  try {
    return estimateStringChars(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

// Used only to bound `max_completion_tokens` below the effective context cap
// for strict OpenAI-compatible servers (e.g. vLLM, StepFun). The CJK-aware
// helper avoids undercounting non-Latin prompts enough to trigger server-side
// context rejections; exhausted estimates enter the existing overflow recovery.
// Estimate the final shaped payload, not the raw context, so compat transforms and dropped
// replay turns are reflected in the output cap.
function estimateOpenAICompletionsInputTokens(payload: {
  messages: unknown[];
  tools?: CompletionsRequest["tools"];
  response_format?: unknown;
}): number {
  let adjustedChars = 0;
  adjustedChars += estimateOpenAICompletionsMessagesChars(payload.messages);
  if (payload.tools?.length) {
    adjustedChars += estimateJsonChars(payload.tools, 1024);
  }
  if (payload.response_format !== undefined) {
    adjustedChars += estimateJsonChars(payload.response_format, 256);
  }
  return Math.ceil(
    (adjustedChars / CHARS_PER_TOKEN_ESTIMATE) * OPENAI_COMPLETIONS_INPUT_TOKEN_SAFETY_MARGIN,
  );
}

function estimateOpenAICompletionsMessagesChars(messages: unknown[]): number {
  let adjustedChars = 0;
  for (const message of messages) {
    if (!message || typeof message !== "object") {
      continue;
    }
    const record = message as Record<string, unknown>;
    adjustedChars += estimateOpenAICompletionsContentChars(record.content);
    for (const field of COMPLETIONS_REASONING_REPLAY_FIELDS) {
      adjustedChars += estimateOpenAICompletionsContentChars(record[field]);
    }
    if (record.tool_calls !== undefined) {
      adjustedChars += estimateJsonChars(record.tool_calls, 256);
    }
  }
  return adjustedChars;
}

function estimateOpenAICompletionsContentChars(value: unknown): number {
  if (typeof value === "string") {
    return estimateStringChars(value);
  }
  if (!Array.isArray(value)) {
    return 0;
  }
  let adjustedChars = 0;
  for (const block of value) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const record = block as Record<string, unknown>;
    if (record.type === "image_url" || record.type === "input_image") {
      adjustedChars += OPENAI_COMPLETIONS_IMAGE_CHAR_ESTIMATE;
      continue;
    }
    const text = record.text;
    if (typeof text === "string") {
      adjustedChars += estimateStringChars(text);
      continue;
    }
    adjustedChars += estimateJsonChars(block, 256);
  }
  return adjustedChars;
}

function convertTools(
  tools: NonNullable<Context["tools"]>,
  compat: ResolvedOpenAICompletionsCompat,
  model: OpenAIModeModel,
  mode: "direct" | "managed",
) {
  const prepared = mode === "managed" ? prepareOpenAITools(tools) : undefined;
  const projection = prepared?.projection ?? projectOpenAITools(tools);
  const convert = () => {
    const strict =
      mode === "direct"
        ? compat.supportsStrictMode
          ? false
          : undefined
        : resolveOpenAIStrictToolFlagWithDiagnostics(
            projection,
            getAiTransportHost().resolveOpenAIStrictToolSetting(model, {
              transport: "stream",
              supportsStrictMode: compat?.supportsStrictMode,
            }),
            {
              transport: "completions",
              model,
            },
          );
    return {
      projection,
      tools: sortTransportToolsByName(projection.tools).map((tool) => {
        const functionTool: {
          name: string;
          description: string | undefined;
          parameters: ReturnType<typeof normalizeOpenAIStrictToolParameters>;
          strict?: boolean;
        } = {
          name: tool.name,
          description: tool.description,
          parameters:
            mode === "direct"
              ? tool.parameters
              : normalizeOpenAIStrictToolParameters(tool.parameters, strict === true, model.compat),
        };
        if (strict !== undefined) {
          functionTool.strict = strict;
        }
        return {
          type: "function" as const,
          function: functionTool,
        };
      }),
    };
  };
  return prepared ? withPreparedToolSchemaNormalization(prepared.schemas, convert) : convert();
}

export function buildOpenAICompletionsParams(
  model: OpenAIModeModel,
  context: Context,
  options: OpenAICompletionsOptions | undefined,
) {
  return buildOpenAICompletionsRequest(model, context, options, { mode: "managed" });
}

type CompletionsRequestPolicy =
  | { mode: "managed" }
  | { mode: "direct"; compat: ResolvedOpenAICompletionsCompat; cacheRetention: CacheRetention };

type CompletionsRequest = Record<string, unknown> & {
  model: string;
  messages: unknown[];
  stream: true;
  tools?: ReturnType<typeof convertTools>["tools"];
};

export function buildOpenAICompletionsRequest(
  model: OpenAIModeModel,
  context: Context,
  options: OpenAICompletionsOptions | undefined,
  policy: CompletionsRequestPolicy,
): CompletionsRequest {
  const resolvedPolicy =
    policy.mode === "direct" ? policy : { ...policy, compat: getCompat(model) };
  const compat = resolvedPolicy.compat;
  const managedCompat = resolvedPolicy.mode === "managed" ? resolvedPolicy.compat : undefined;
  const endpointDetection = detectOpenAICompletionsCompat(model);
  const compatDetection = policy.mode === "managed" ? endpointDetection : undefined;
  const { endpointClass } = endpointDetection.capabilities;
  const cacheRetention =
    policy.mode === "direct"
      ? policy.cacheRetention
      : resolveCacheRetention(options?.cacheRetention);
  const cacheControl = resolveCompletionsCacheControl(
    compat,
    cacheRetention,
    endpointClass === "openrouter" ||
      (endpointClass === "default" && model.provider === "openrouter"),
  );
  const markTools =
    endpointClass !== "modelstudio-native" &&
    !(endpointClass === "default" && ["modelstudio", "dashscope", "qwen"].includes(model.provider));
  const cacheOptOutIndexes = new Set<number>();
  // The converter needs intact boundaries for Runtime relocation or cache markers.
  const convertedMessages = convertMessages(model as never, context, compat as never, {
    cacheOptOutIndexes,
    preserveSystemPromptCacheBoundary:
      cacheControl !== undefined && !managedCompat?.requiresStringContent,
  });
  let messages: unknown[] = convertedMessages;
  if (managedCompat) {
    applyCompletionsReplay(convertedMessages, context, model, managedCompat);
    if (managedCompat.strictMessageKeys) {
      messages = stripCompletionMessagesToRoleContent(messages);
    }
    if (managedCompat.requiresStringContent) {
      messages = flattenCompletionMessagesToStringContent(messages);
    }
  }
  const promptCacheKey = resolvePromptCacheKey(options, cacheRetention);
  const params: CompletionsRequest = {
    model: model.id,
    messages,
    stream: true,
    ...resolveOpenAIPromptCacheParams(model, cacheRetention, compat),
  };
  if (compat.supportsUsageInStreaming) {
    params.stream_options = { include_usage: true };
  }
  if (compat.supportsStore) {
    params.store = false;
  }
  if (policy.mode === "direct" || (compat.supportsPromptCacheKey && promptCacheKey)) {
    params.prompt_cache_key = compat.supportsPromptCacheKey ? promptCacheKey : undefined;
  }
  if (options?.temperature !== undefined) {
    params.temperature = options.temperature;
  }
  if (policy.mode === "managed" && options?.topP !== undefined) {
    params.top_p = options.topP;
  }
  const requestedResponseFormat = options?.responseFormat;
  const responseFormat =
    policy.mode === "direct" && requestedResponseFormat === undefined
      ? undefined
      : resolveOpenAICompletionsResponseFormat(
          shouldOmitOllamaCompatResponseFormat({
            provider: model.provider,
            baseUrl: model.baseUrl,
            hasTools: () => Boolean(context.tools?.length),
          })
            ? undefined
            : requestedResponseFormat,
          compat.supportsJsonSchemaResponseFormat,
        );
  if (responseFormat !== undefined) {
    params.response_format = responseFormat;
  }
  if (policy.mode === "managed" && options?.frequencyPenalty !== undefined) {
    params.frequency_penalty = options.frequencyPenalty;
  }
  if (policy.mode === "managed" && options?.presencePenalty !== undefined) {
    params.presence_penalty = options.presencePenalty;
  }
  if (policy.mode === "managed" && options?.seed !== undefined) {
    params.seed = options.seed;
  }
  if (options?.stop !== undefined && options.stop.length > 0) {
    params.stop = options.stop;
  }
  let directToolProjection: ReturnType<typeof projectOpenAITools> | undefined;
  if (policy.mode === "direct" || supportsModelTools(model)) {
    if (context.tools) {
      const converted = convertTools(context.tools, compat, model, policy.mode);
      if (policy.mode === "direct") {
        directToolProjection = converted.projection;
      }
      if (
        converted.tools.length > 0 ||
        (policy.mode === "managed" &&
          converted.projection.inputToolCount === 0 &&
          converted.projection.diagnostics.length === 0)
      ) {
        params.tools = converted.tools;
      } else if (hasToolCallHistory(context.messages)) {
        params.tools = [];
      }
      if (policy.mode === "direct" && compat.zaiToolStream && converted.tools.length > 0) {
        params.tool_stream = true;
      }
      if (policy.mode === "managed" && options?.toolChoice) {
        const toolChoice = reconcileOpenAICompletionsToolChoice(
          options.toolChoice,
          converted.projection,
        );
        if (toolChoice !== undefined) {
          params.tool_choice = toolChoice;
        }
      } else if (
        compatDetection?.capabilities.usesExplicitProxyLikeEndpoint &&
        params.tools?.length
      ) {
        params.tool_choice = "auto";
      }
    } else if (hasToolCallHistory(context.messages)) {
      params.tools = [];
    }
    if (compatDetection?.capabilities.usesExplicitProxyLikeEndpoint && params.tools?.length === 0) {
      delete params.tools;
      delete params.tool_choice;
    }
  }
  if (policy.mode === "direct" && compat.cacheControlFormat === "anthropic") {
    applyCompletionsAnthropicCacheControl(
      params,
      cacheControl ?? null,
      cacheOptOutIndexes,
      markTools,
    );
  }
  if (policy.mode === "direct" && options?.toolChoice) {
    const toolChoice = reconcileOpenAICompletionsToolChoice(
      options.toolChoice,
      directToolProjection ?? projectOpenAITools([]),
    );
    if (toolChoice !== undefined) {
      params.tool_choice = toolChoice;
    }
  }
  const isOpenRouter = compat.thinkingFormat === "openrouter";
  // Only model metadata can declare a missing effort selector; endpoint defaults cannot.
  const usesBinaryOpenRouterThinking =
    isOpenRouter &&
    (model.compat?.supportsReasoningEffort === false ||
      model.compat?.supportedReasoningEfforts?.length === 0);
  const simpleReasoning = options?.reasoning;
  const requestedEffort =
    policy.mode === "direct"
      ? options?.reasoningEffort
      : (options?.reasoningEffort ??
        (simpleReasoning === "none"
          ? "none"
          : resolveOpenAISimpleReasoningEffort(
              { ...model, compat: model.compat ?? undefined },
              simpleReasoning,
            )) ??
        (usesBinaryOpenRouterThinking ? undefined : "high"));
  const reasoning = resolveOpenAIRequestReasoning(model, requestedEffort);
  const { effort, thinkingEnabled } = reasoning;
  {
    const maxTokenBudget =
      policy.mode === "direct"
        ? { maxTokens: options?.maxTokens, clampToModelMaxTokens: true }
        : resolveOpenAICompletionsMaxTokens(model, options);
    const effectiveMaxTokens = maxTokenBudget.maxTokens;
    const effectiveContextTokens =
      asPositiveFiniteNumber((model as { contextTokens?: number }).contextTokens) ??
      asPositiveFiniteNumber(model.contextWindow);
    let clampedMaxTokens = effectiveMaxTokens;
    const modelMaxTokens = resolveOpenAICompletionsModelMaxTokens(model);
    if (
      maxTokenBudget.clampToModelMaxTokens &&
      clampedMaxTokens !== undefined &&
      modelMaxTokens !== undefined &&
      clampedMaxTokens > modelMaxTokens
    ) {
      clampedMaxTokens = modelMaxTokens;
      if (policy.mode === "managed") {
        emitModelTransportDebug(
          log,
          `[completions] clamp_max_tokens provider=${model.provider} api=${model.api} ` +
            `model=${model.id} requested=${effectiveMaxTokens} output=${clampedMaxTokens} ` +
            `modelMaxTokens=${modelMaxTokens}`,
        );
      }
    }
    if (
      compatDetection?.capabilities.usesExplicitProxyLikeEndpoint &&
      clampedMaxTokens !== undefined &&
      effectiveContextTokens !== undefined
    ) {
      const estimatedInputTokens = estimateOpenAICompletionsInputTokens(params);
      const remainingBudget = Math.max(0, effectiveContextTokens - estimatedInputTokens - 1);
      if (clampedMaxTokens > remainingBudget) {
        if (remainingBudget < MIN_USEFUL_OUTPUT_TOKENS) {
          throw Object.assign(
            new Error(
              `Context window exceeded: estimated input ${estimatedInputTokens} leaves only ` +
                `${remainingBudget} output tokens within the ${effectiveContextTokens}-token context.`,
            ),
            { code: "context_length_exceeded" },
          );
        }
        clampedMaxTokens = remainingBudget;
        emitModelTransportDebug(
          log,
          `[completions] clamp_max_tokens provider=${model.provider} api=${model.api} ` +
            `model=${model.id} requested=${effectiveMaxTokens} output=${clampedMaxTokens} ` +
            `effectiveContext=${effectiveContextTokens} estimatedInput=${estimatedInputTokens}`,
        );
      }
    }
    if (policy.mode === "direct" ? options?.maxTokens : clampedMaxTokens) {
      if (compat.maxTokensField === "max_tokens") {
        params.max_tokens = clampedMaxTokens;
      } else {
        params.max_completion_tokens = clampedMaxTokens;
      }
    }
  }
  if (isOpenRouter && model.reasoning) {
    if (usesBinaryOpenRouterThinking && thinkingEnabled !== undefined) {
      params.reasoning = { enabled: thinkingEnabled };
    } else if (effort !== undefined) {
      params.reasoning = { effort };
    }
  }
  applyCompletionsReasoningAndRouting(params, model, reasoning, compat, policy.mode);
  if (policy.mode === "managed" && compat.cacheControlFormat === "anthropic") {
    applyCompletionsAnthropicCacheControl(
      params,
      cacheControl ?? null,
      cacheOptOutIndexes,
      markTools,
      !managedCompat?.requiresStringContent,
    );
  }
  if (params.tools?.length && isKnownOpenAICompletionsEndpoint(model)) {
    // Native Chat Completions rejects tools with enabled GPT-5.6 reasoning,
    // and rejects the effort field entirely for GPT-5.4 Mini and GPT-5.5 tools.
    if (isOpenAIGpt56Model(model)) {
      params.reasoning_effort = "none";
    } else if (isOpenAIGpt54MiniModel(model) || isOpenAIGpt55Model(model)) {
      delete params.reasoning_effort;
    }
  }
  return params;
}
