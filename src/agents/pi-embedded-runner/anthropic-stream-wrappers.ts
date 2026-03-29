import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveFastModeParam } from "../fast-mode.js";
import {
  type ProviderCapabilityLookupOptions,
  requiresOpenAiCompatibleAnthropicToolPayload,
  usesOpenAiFunctionAnthropicToolSchema,
  usesOpenAiStringModeAnthropicToolChoice,
} from "../provider-capabilities.js";
import { log } from "./logger.js";
import { streamWithPayloadPatch } from "./stream-payload-utils.js";

const ANTHROPIC_CONTEXT_1M_BETA = "context-1m-2025-08-07";
const ANTHROPIC_1M_MODEL_PREFIXES = ["claude-opus-4", "claude-sonnet-4"] as const;
const PI_AI_DEFAULT_ANTHROPIC_BETAS = [
  "fine-grained-tool-streaming-2025-05-14",
  "interleaved-thinking-2025-05-14",
] as const;
const PI_AI_OAUTH_ANTHROPIC_BETAS = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  ...PI_AI_DEFAULT_ANTHROPIC_BETAS,
] as const;
type AnthropicServiceTier = "auto" | "standard_only";

type CacheRetention = "none" | "short" | "long";
type AnthropicToolPayloadResolverOptions = ProviderCapabilityLookupOptions;

function isAnthropic1MModel(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase();
  return ANTHROPIC_1M_MODEL_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function parseHeaderList(value: unknown): string[] {
  if (typeof value !== "string") {
    return [];
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function mergeAnthropicBetaHeader(
  headers: Record<string, string> | undefined,
  betas: string[],
): Record<string, string> {
  const merged = { ...headers };
  const existingKey = Object.keys(merged).find((key) => key.toLowerCase() === "anthropic-beta");
  const existing = existingKey ? parseHeaderList(merged[existingKey]) : [];
  const values = Array.from(new Set([...existing, ...betas]));
  const key = existingKey ?? "anthropic-beta";
  merged[key] = values.join(",");
  return merged;
}

function isAnthropicOAuthApiKey(apiKey: unknown): boolean {
  return typeof apiKey === "string" && apiKey.includes("sk-ant-oat");
}

function isAnthropicPublicApiBaseUrl(baseUrl: unknown): boolean {
  if (baseUrl == null) {
    return true;
  }
  if (typeof baseUrl !== "string" || !baseUrl.trim()) {
    return true;
  }

  try {
    return new URL(baseUrl).hostname.toLowerCase() === "api.anthropic.com";
  } catch {
    return baseUrl.toLowerCase().includes("api.anthropic.com");
  }
}

function resolveAnthropicFastServiceTier(enabled: boolean): AnthropicServiceTier {
  return enabled ? "auto" : "standard_only";
}

function hasOpenAiAnthropicToolPayloadCompatFlag(model: { compat?: unknown }): boolean {
  if (!model.compat || typeof model.compat !== "object" || Array.isArray(model.compat)) {
    return false;
  }

  return (
    (model.compat as { requiresOpenAiAnthropicToolPayload?: unknown })
      .requiresOpenAiAnthropicToolPayload === true
  );
}

function normalizeAnthropicServiceTier(value: unknown): AnthropicServiceTier | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "auto" || normalized === "standard_only") {
    return normalized;
  }
  return undefined;
}

function requiresAnthropicToolPayloadCompatibilityForModel(
  model: {
    api?: unknown;
    provider?: unknown;
    compat?: unknown;
  },
  options?: AnthropicToolPayloadResolverOptions,
): boolean {
  if (model.api !== "anthropic-messages") {
    return false;
  }

  if (
    typeof model.provider === "string" &&
    requiresOpenAiCompatibleAnthropicToolPayload(model.provider, options)
  ) {
    return true;
  }
  return hasOpenAiAnthropicToolPayloadCompatFlag(model);
}

function usesOpenAiFunctionAnthropicToolSchemaForModel(
  model: {
    provider?: unknown;
    compat?: unknown;
  },
  options?: AnthropicToolPayloadResolverOptions,
): boolean {
  if (
    typeof model.provider === "string" &&
    usesOpenAiFunctionAnthropicToolSchema(model.provider, options)
  ) {
    return true;
  }
  return hasOpenAiAnthropicToolPayloadCompatFlag(model);
}

function usesOpenAiStringModeAnthropicToolChoiceForModel(
  model: {
    provider?: unknown;
    compat?: unknown;
  },
  options?: AnthropicToolPayloadResolverOptions,
): boolean {
  if (
    typeof model.provider === "string" &&
    usesOpenAiStringModeAnthropicToolChoice(model.provider, options)
  ) {
    return true;
  }
  return hasOpenAiAnthropicToolPayloadCompatFlag(model);
}

function normalizeOpenAiFunctionAnthropicToolDefinition(
  tool: unknown,
): Record<string, unknown> | undefined {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) {
    return undefined;
  }

  const toolObj = tool as Record<string, unknown>;
  if (toolObj.function && typeof toolObj.function === "object") {
    return toolObj;
  }

  const rawName = typeof toolObj.name === "string" ? toolObj.name.trim() : "";
  if (!rawName) {
    return toolObj;
  }

  const functionSpec: Record<string, unknown> = {
    name: rawName,
    parameters:
      toolObj.input_schema && typeof toolObj.input_schema === "object"
        ? toolObj.input_schema
        : toolObj.parameters && typeof toolObj.parameters === "object"
          ? toolObj.parameters
          : { type: "object", properties: {} },
  };

  if (typeof toolObj.description === "string" && toolObj.description.trim()) {
    functionSpec.description = toolObj.description;
  }
  if (typeof toolObj.strict === "boolean") {
    functionSpec.strict = toolObj.strict;
  }

  return {
    type: "function",
    function: functionSpec,
  };
}

function normalizeOpenAiStringModeAnthropicToolChoice(toolChoice: unknown): unknown {
  if (!toolChoice || typeof toolChoice !== "object" || Array.isArray(toolChoice)) {
    return toolChoice;
  }

  const choice = toolChoice as Record<string, unknown>;
  if (choice.type === "auto") {
    return "auto";
  }
  if (choice.type === "none") {
    return "none";
  }
  if (choice.type === "required" || choice.type === "any") {
    return "required";
  }
  if (choice.type === "tool" && typeof choice.name === "string" && choice.name.trim()) {
    return {
      type: "function",
      function: { name: choice.name.trim() },
    };
  }

  return toolChoice;
}

export function resolveCacheRetention(
  extraParams: Record<string, unknown> | undefined,
  provider: string,
): CacheRetention | undefined {
  const isAnthropicDirect = provider === "anthropic";
  const hasBedrockOverride =
    extraParams?.cacheRetention !== undefined || extraParams?.cacheControlTtl !== undefined;
  const isAnthropicBedrock = provider === "amazon-bedrock" && hasBedrockOverride;

  if (!isAnthropicDirect && !isAnthropicBedrock) {
    return undefined;
  }

  const newVal = extraParams?.cacheRetention;
  if (newVal === "none" || newVal === "short" || newVal === "long") {
    return newVal;
  }

  const legacy = extraParams?.cacheControlTtl;
  if (legacy === "5m") {
    return "short";
  }
  if (legacy === "1h") {
    return "long";
  }

  return isAnthropicDirect ? "short" : undefined;
}

export function resolveAnthropicBetas(
  extraParams: Record<string, unknown> | undefined,
  provider: string,
  modelId: string,
): string[] | undefined {
  if (provider !== "anthropic") {
    return undefined;
  }

  const betas = new Set<string>();
  const configured = extraParams?.anthropicBeta;
  if (typeof configured === "string" && configured.trim()) {
    betas.add(configured.trim());
  } else if (Array.isArray(configured)) {
    for (const beta of configured) {
      if (typeof beta === "string" && beta.trim()) {
        betas.add(beta.trim());
      }
    }
  }

  if (extraParams?.context1m === true) {
    if (isAnthropic1MModel(modelId)) {
      betas.add(ANTHROPIC_CONTEXT_1M_BETA);
    } else {
      log.warn(`ignoring context1m for non-opus/sonnet model: ${provider}/${modelId}`);
    }
  }

  return betas.size > 0 ? [...betas] : undefined;
}

export function createAnthropicBetaHeadersWrapper(
  baseStreamFn: StreamFn | undefined,
  betas: string[],
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    const isOauth = isAnthropicOAuthApiKey(options?.apiKey);
    const requestedContext1m = betas.includes(ANTHROPIC_CONTEXT_1M_BETA);
    const effectiveBetas =
      isOauth && requestedContext1m
        ? betas.filter((beta) => beta !== ANTHROPIC_CONTEXT_1M_BETA)
        : betas;
    if (isOauth && requestedContext1m) {
      log.warn(
        `ignoring context1m for OAuth token auth on ${model.provider}/${model.id}; Anthropic rejects context-1m beta with OAuth auth`,
      );
    }

    const piAiBetas = isOauth
      ? (PI_AI_OAUTH_ANTHROPIC_BETAS as readonly string[])
      : (PI_AI_DEFAULT_ANTHROPIC_BETAS as readonly string[]);
    const allBetas = [...new Set([...piAiBetas, ...effectiveBetas])];
    return underlying(model, context, {
      ...options,
      headers: mergeAnthropicBetaHeader(options?.headers, allBetas),
    });
  };
}

export function createAnthropicToolPayloadCompatibilityWrapper(
  baseStreamFn: StreamFn | undefined,
  resolverOptions?: {
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
  },
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, streamOptions) => {
    const originalOnPayload = streamOptions?.onPayload;
    return underlying(model, context, {
      ...streamOptions,
      onPayload: (payload) => {
        if (
          payload &&
          typeof payload === "object" &&
          requiresAnthropicToolPayloadCompatibilityForModel(model, {
            config: resolverOptions?.config,
            workspaceDir: resolverOptions?.workspaceDir,
            env: resolverOptions?.env,
          })
        ) {
          const payloadObj = payload as Record<string, unknown>;
          if (
            Array.isArray(payloadObj.tools) &&
            usesOpenAiFunctionAnthropicToolSchemaForModel(model, {
              config: resolverOptions?.config,
              workspaceDir: resolverOptions?.workspaceDir,
              env: resolverOptions?.env,
            })
          ) {
            payloadObj.tools = payloadObj.tools
              .map((tool) => normalizeOpenAiFunctionAnthropicToolDefinition(tool))
              .filter((tool): tool is Record<string, unknown> => !!tool);
          }
          if (
            usesOpenAiStringModeAnthropicToolChoiceForModel(model, {
              config: resolverOptions?.config,
              workspaceDir: resolverOptions?.workspaceDir,
              env: resolverOptions?.env,
            })
          ) {
            payloadObj.tool_choice = normalizeOpenAiStringModeAnthropicToolChoice(
              payloadObj.tool_choice,
            );
          }
        }
        return originalOnPayload?.(payload, model);
      },
    });
  };
}

export function createAnthropicFastModeWrapper(
  baseStreamFn: StreamFn | undefined,
  enabled: boolean,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  const serviceTier = resolveAnthropicFastServiceTier(enabled);
  return (model, context, options) => {
    if (
      model.api !== "anthropic-messages" ||
      model.provider !== "anthropic" ||
      !isAnthropicPublicApiBaseUrl(model.baseUrl)
    ) {
      return underlying(model, context, options);
    }

    return streamWithPayloadPatch(underlying, model, context, options, (payloadObj) => {
      if (payloadObj.service_tier === undefined) {
        payloadObj.service_tier = serviceTier;
      }
    });
  };
}

export function createAnthropicServiceTierWrapper(
  baseStreamFn: StreamFn | undefined,
  serviceTier: AnthropicServiceTier,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    if (
      model.api !== "anthropic-messages" ||
      model.provider !== "anthropic" ||
      !isAnthropicPublicApiBaseUrl(model.baseUrl)
    ) {
      return underlying(model, context, options);
    }

    return streamWithPayloadPatch(underlying, model, context, options, (payloadObj) => {
      if (payloadObj.service_tier === undefined) {
        payloadObj.service_tier = serviceTier;
      }
    });
  };
}

export function resolveAnthropicFastMode(
  extraParams: Record<string, unknown> | undefined,
): boolean | undefined {
  return resolveFastModeParam(extraParams);
}

export function resolveAnthropicServiceTier(
  extraParams: Record<string, unknown> | undefined,
): AnthropicServiceTier | undefined {
  const raw = extraParams?.serviceTier ?? extraParams?.service_tier;
  const normalized = normalizeAnthropicServiceTier(raw);
  if (raw !== undefined && normalized === undefined) {
    const rawSummary = typeof raw === "string" ? raw : typeof raw;
    log.warn(`ignoring invalid Anthropic service tier param: ${rawSummary}`);
  }
  return normalized;
}
