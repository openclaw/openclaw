import type { CacheRetention, Model } from "@openclaw/llm-core";
import {
  CHARS_PER_TOKEN_ESTIMATE,
  estimateStringChars,
} from "@openclaw/normalization-core/cjk-chars";
import { asPositiveFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { getAiTransportHost } from "../host.js";
import { convertMessages, hasToolCallHistory } from "../openai-completions-messages.js";
import { measuredRequestPressure, type OpenAICompletionsOptions } from "../provider-options.js";
import {
  PROVIDER_MODEL_INPUT,
  type ProviderContext,
  type ProviderModel,
} from "../provider-types.js";
import { resolveCacheRetention } from "../providers/cache-retention.js";
import { prepareOpenAIFunctionTool } from "../providers/openai-function-tool.js";
import { resolveOpenAIPromptCacheParams } from "../providers/openai-prompt-cache.js";
import { applyOpenAICompletionsToolReasoning } from "../providers/openai-reasoning-effort.js";
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
import { normalizeToolSchema } from "../providers/tool-schema-normalization.js";
import { shortHash } from "../utils/hash.js";
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
import { supportsModelTools } from "./transport-utils.js";

type OpenAIThinkingProvenanceOptions = OpenAICompletionsOptions & {
  openclawThinkingExplicit?: boolean;
};

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

const OPENAI_COMPLETIONS_INPUT_TOKEN_SAFETY_MARGIN = 1.25;
const OPENAI_COMPLETIONS_IMAGE_CHAR_ESTIMATE = 8_000;
// Video is projected into frames by vision servers; base64 size is not a token count.
const OPENAI_COMPLETIONS_VIDEO_CHAR_ESTIMATE = 96_000;
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
  let adjustedChars = estimateOpenAICompletionsMessagesChars(payload.messages);
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
    if (record.type === "video_url" || record.type === "input_video") {
      adjustedChars += OPENAI_COMPLETIONS_VIDEO_CHAR_ESTIMATE;
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
  tools: NonNullable<ProviderContext["tools"]>,
  compat: ResolvedOpenAICompletionsCompat,
  model: OpenAIModeModel,
  mode: "direct" | "managed",
  mutableParameters: boolean,
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
        const parameters = compat.requiresTypedUnionBranches
          ? normalizeToolSchema(tool.parameters, "moonshot")
          : tool.parameters;
        return prepareOpenAIFunctionTool(
          tool.name,
          tool.description,
          mode === "direct"
            ? parameters
            : normalizeOpenAIStrictToolParameters(parameters, strict === true, model.compat),
          strict,
          mutableParameters,
        ).completions;
      }),
    };
  };
  return prepared ? withPreparedToolSchemaNormalization(prepared.schemas, convert) : convert();
}

export function buildOpenAICompletionsParams(
  model: OpenAIModeModel,
  context: ProviderContext,
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
  stream: boolean;
  tools?: ReturnType<typeof convertTools>["tools"];
};

const contextOutputBudgets = new WeakMap<
  CompletionsRequest,
  {
    model: string;
    cap: number;
    inputHash: string;
  }
>();

function completionsInputHash(payload: CompletionsRequest): string {
  return shortHash(JSON.stringify([payload.messages, payload.tools, payload.response_format]));
}

// Hooks may replace or mutate the payload. Only an unchanged automatic context
// clamp can turn a provider's length finish into compaction recovery.
export function resolveCompletionsContextOutputBudget(
  request: CompletionsRequest,
  payload: CompletionsRequest,
): number | undefined {
  const budget = contextOutputBudgets.get(request);
  const limits = [payload.max_tokens, payload.max_completion_tokens].filter(
    (value) => value !== undefined,
  );
  if (
    !budget ||
    payload.model !== budget.model ||
    !Array.isArray(payload.messages) ||
    (payload.tools !== undefined && !Array.isArray(payload.tools)) ||
    limits.length === 0 ||
    limits.some((value) => value !== budget.cap) ||
    completionsInputHash(payload) !== budget.inputHash
  ) {
    return undefined;
  }
  return budget.cap;
}

export function buildOpenAICompletionsRequest(
  model: OpenAIModeModel,
  context: ProviderContext,
  options: OpenAIThinkingProvenanceOptions | undefined,
  policy: CompletionsRequestPolicy,
): CompletionsRequest {
  let contextOutputCap: number | undefined;
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
  const supportsTools = policy.mode === "direct" || supportsModelTools(model);
  const converted =
    supportsTools && context.tools
      ? convertTools(context.tools, compat, model, policy.mode, Boolean(options?.onPayload))
      : undefined;
  // The converter needs intact boundaries for Runtime relocation or cache markers.
  const providerModel: ProviderModel = {
    ...model,
    input: options?.[PROVIDER_MODEL_INPUT] ?? model.input,
    compat,
  };
  const convertedMessages = convertMessages(providerModel, context, compat, {
    cacheOptOutIndexes,
    supportsTools,
    declaredToolNames: new Set(converted?.projection.tools.map((tool) => tool.name)),
    preserveSystemPromptCacheBoundary:
      cacheControl !== undefined && !managedCompat?.requiresStringContent,
  });
  applyCompletionsReplay(convertedMessages, context, model, compat);
  let messages: unknown[] = convertedMessages;
  if (managedCompat) {
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
    stream: (options?.streaming ?? model.params?.streaming) !== false,
    ...resolveOpenAIPromptCacheParams(model, cacheRetention, compat),
  };
  if (params.stream && compat.supportsUsageInStreaming) {
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
  if (supportsTools) {
    if (converted) {
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
      if (
        policy.mode === "direct" &&
        params.stream &&
        compat.zaiToolStream &&
        converted.tools.length > 0
      ) {
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
      true,
      compat.cacheControlSystemOnly,
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
  // Keep raw selection separate from the managed effort fallback.
  const thinkingExplicit =
    options?.openclawThinkingExplicit ??
    (options?.reasoningEffort !== undefined || options?.reasoning !== undefined);
  const { effort, thinkingEnabled } = resolveOpenAIRequestReasoning(
    model,
    requestedEffort,
    compat.reasoningEffortForOff,
  );
  const direct = policy.mode === "direct";
  {
    let effectiveMaxTokens = options?.maxTokens;
    const clampToModelMaxTokens = direct || Boolean(effectiveMaxTokens);
    if (!direct && !effectiveMaxTokens) {
      effectiveMaxTokens = resolveMaxTokensParam(model.params) || model.maxTokens;
    }
    const effectiveContextTokens =
      asPositiveFiniteNumber((model as { contextTokens?: number }).contextTokens) ??
      asPositiveFiniteNumber(model.contextWindow);
    let clampedMaxTokens = effectiveMaxTokens;
    const modelOutputLimit = asPositiveFiniteNumber(model.maxTokens);
    const modelMaxTokens =
      modelOutputLimit === undefined ? undefined : Math.floor(modelOutputLimit);
    if (
      clampToModelMaxTokens &&
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
      // The measured predecessor does not bind the response-format identity.
      const measuredInputTokens =
        params.response_format === undefined
          ? measuredRequestPressure.get(model, context)
          : undefined;
      const estimatedInputTokens =
        measuredInputTokens ?? estimateOpenAICompletionsInputTokens(params);
      const remainingBudget = Math.max(0, effectiveContextTokens - estimatedInputTokens - 1);
      if (clampedMaxTokens > remainingBudget) {
        // Tool arguments need useful headroom even when the provider accepts a smaller cap.
        const minimumOutputTokens =
          params.tools?.length && params.tool_choice !== "none"
            ? Math.max(
                MIN_USEFUL_OUTPUT_TOKENS,
                Math.min(2_048, Math.ceil((modelMaxTokens ?? 0) / 8)),
              )
            : MIN_USEFUL_OUTPUT_TOKENS;
        if (remainingBudget < minimumOutputTokens) {
          throw Object.assign(
            new Error(
              `Context window exceeded: estimated input ${estimatedInputTokens} leaves only ` +
                `${remainingBudget} output tokens within the ${effectiveContextTokens}-token context.`,
            ),
            { code: "context_length_exceeded" },
          );
        }
        clampedMaxTokens = remainingBudget;
        contextOutputCap = remainingBudget;
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
  const nativeEffort = compat.thinkingFormat === "openrouter" ? undefined : effort;
  const enabled = thinkingEnabled ?? false;
  if (
    model.reasoning &&
    (!compat.thinkingOffControlUndeclared || thinkingEnabled !== undefined || !thinkingExplicit)
  ) {
    let allowScalarEffort = true;
    if (direct && compat.thinkingFormat === "zai") {
      params.thinking = enabled ? { type: "enabled", clear_thinking: false } : { type: "disabled" };
      allowScalarEffort = false;
    } else if (compat.thinkingFormat === "qwen") {
      params.enable_thinking = enabled;
      allowScalarEffort = false;
    } else if (compat.thinkingFormat === "qwen-chat-template") {
      const chatTemplateReasoningEffort =
        enabled && thinkingExplicit && model.compat?.supportedReasoningEfforts?.length
          ? effort
          : undefined;
      params.chat_template_kwargs = {
        enable_thinking: enabled,
        ...(direct ? { preserve_thinking: true } : {}),
        ...(chatTemplateReasoningEffort ? { reasoning_effort: chatTemplateReasoningEffort } : {}),
      };
      allowScalarEffort = false;
    } else if (
      compat.thinkingFormat === "together" ||
      (direct && compat.thinkingFormat === "deepseek")
    ) {
      if (compat.thinkingFormat === "deepseek") {
        params.thinking = { type: enabled ? "enabled" : "disabled" };
      } else {
        params.reasoning = { enabled };
      }
      allowScalarEffort = enabled;
    }
    if (
      allowScalarEffort &&
      compat.supportsReasoningEffort &&
      (direct ? nativeEffort !== undefined : nativeEffort)
    ) {
      params.reasoning_effort = nativeEffort;
    }
  }
  if (direct) {
    if (compat.openRouterRouting) {
      params.provider = compat.openRouterRouting;
    }
    if (model.baseUrl.includes("ai-gateway.vercel.sh") && model.compat?.vercelGatewayRouting) {
      const routing = model.compat.vercelGatewayRouting;
      if (routing.only || routing.order) {
        const gatewayOptions: Record<string, string[]> = {};
        if (routing.only) {
          gatewayOptions.only = routing.only;
        }
        if (routing.order) {
          gatewayOptions.order = routing.order;
        }
        params.providerOptions = { gateway: gatewayOptions };
      }
    }
  }
  if (policy.mode === "managed" && compat.cacheControlFormat === "anthropic") {
    applyCompletionsAnthropicCacheControl(
      params,
      cacheControl ?? null,
      cacheOptOutIndexes,
      markTools,
      !managedCompat?.requiresStringContent,
      compat.cacheControlSystemOnly,
    );
  }
  if (params.tools?.length && isKnownOpenAICompletionsEndpoint(model)) {
    applyOpenAICompletionsToolReasoning(params, model);
  }
  if (contextOutputCap !== undefined) {
    contextOutputBudgets.set(params, {
      model: params.model,
      cap: contextOutputCap,
      inputHash: completionsInputHash(params),
    });
  }
  return params;
}
