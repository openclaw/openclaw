import { resolveAgentConfig } from "openclaw/plugin-sdk/agent-scope-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeOpenRouterApiModelId } from "./models.js";

type OpenRouterModelParamsContext = { config?: OpenClawConfig; agentId?: string; modelId: string };

// Openrouter provider module implements model/runtime integration.
type OpenRouterExtraParamsContext = {
  config?: {
    models?: {
      providers?: Record<
        string,
        {
          params?: Record<string, unknown>;
        }
      >;
    };
  };
  extraParams: Record<string, unknown>;
  provider: string;
  model?: {
    params?: Record<string, unknown>;
  };
};

const BLOCKED_RECORD_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function sanitizeJsonLikeValue(value: unknown): unknown {
  if (value === undefined) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeJsonLikeValue).filter((entry) => entry !== undefined);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return sanitizeRecord(value as Record<string, unknown>);
}

function sanitizeRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, entry]) => !BLOCKED_RECORD_KEYS.has(key) && entry !== undefined)
      .map(([key, entry]) => [key, sanitizeJsonLikeValue(entry)]),
  );
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const sanitized = sanitizeRecord(value as Record<string, unknown>);
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function mergeOpenRouterProviderRouting(
  ...sources: (Record<string, unknown> | undefined)[]
): Record<string, unknown> | undefined {
  const merged = Object.fromEntries(
    sources.flatMap((source) => Object.entries(readRecord(source?.provider) ?? {})),
  );
  return Object.keys(merged).length > 0 ? merged : undefined;
}

export function resolveOpenRouterExtraParamsForTransport(
  ctx: OpenRouterExtraParamsContext,
): { patch?: Record<string, unknown> } | undefined {
  const providerConfigParams = readRecord(ctx.config?.models?.providers?.[ctx.provider]?.params);
  const modelParams = readRecord(ctx.model?.params);
  const providerRouting = mergeOpenRouterProviderRouting(
    providerConfigParams,
    modelParams,
    ctx.extraParams,
  );
  if (!providerConfigParams && !modelParams && !providerRouting) {
    return undefined;
  }
  return {
    patch: {
      ...providerConfigParams,
      ...modelParams,
      ...ctx.extraParams,
      ...(providerRouting ? { provider: providerRouting } : {}),
    },
  };
}

function openRouterModelConfigKey(modelId: string): string {
  const providerPrefix = "openrouter/";
  return modelId.trim().toLowerCase().startsWith(providerPrefix)
    ? modelId
    : `openrouter/${modelId}`;
}

function findConfiguredOpenRouterModelParams(
  ctx: OpenRouterModelParamsContext,
  configuredModels = ctx.config?.agents?.defaults?.models,
): Record<string, unknown> | undefined {
  if (!configuredModels) {
    return undefined;
  }

  const normalizedModelId = normalizeOpenRouterApiModelId(ctx.modelId) ?? ctx.modelId;
  const directKeys = [
    openRouterModelConfigKey(ctx.modelId),
    openRouterModelConfigKey(normalizedModelId),
    `openrouter/${ctx.modelId}`,
    `openrouter/${normalizedModelId}`,
  ];
  for (const key of directKeys) {
    const params = readRecord(configuredModels[key]?.params);
    if (params) {
      return params;
    }
  }

  for (const [rawKey, entry] of Object.entries(configuredModels)) {
    const slashIndex = rawKey.indexOf("/");
    if (slashIndex <= 0) {
      continue;
    }
    const provider = rawKey.slice(0, slashIndex).trim().toLowerCase();
    const modelId = rawKey.slice(slashIndex + 1);
    const candidateModelId = normalizeOpenRouterApiModelId(modelId) ?? modelId;
    if (
      provider === "openrouter" &&
      candidateModelId.trim().toLowerCase() === normalizedModelId.trim().toLowerCase()
    ) {
      return readRecord(entry.params);
    }
  }

  return undefined;
}

export function resolveOpenRouterConfiguredExtraParams(
  ctx: OpenRouterModelParamsContext,
): Record<string, unknown> | undefined {
  const agent = ctx.agentId ? resolveAgentConfig(ctx.config ?? {}, ctx.agentId) : undefined;
  const sources = [
    readRecord(ctx.config?.agents?.defaults?.params),
    findConfiguredOpenRouterModelParams(ctx),
    agent?.models ? findConfiguredOpenRouterModelParams(ctx, agent.models) : undefined,
    readRecord(agent?.params),
  ];
  const merged = Object.fromEntries(sources.flatMap((source) => Object.entries(source ?? {})));
  // An endpoint preference must not erase inherited privacy or routing constraints.
  const provider = mergeOpenRouterProviderRouting(...sources);
  if (provider) {
    merged.provider = provider;
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}
