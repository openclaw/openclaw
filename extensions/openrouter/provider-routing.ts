// Openrouter provider module implements model/runtime integration.
import { normalizeProviderId } from "openclaw/plugin-sdk/provider-model-shared";

type OpenRouterProviderConfig = {
  params?: Record<string, unknown>;
};

type OpenRouterExtraParamsContext = {
  config?: {
    models?: {
      providers?: Record<string, OpenRouterProviderConfig>;
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

function mergeOpenRouterProviderConfigParams(
  previous: Record<string, unknown> | undefined,
  next: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...previous };
  for (const [key, value] of Object.entries(next)) {
    const previousRecord = readRecord(merged[key]);
    const nextRecord = readRecord(value);
    merged[key] =
      previousRecord && nextRecord
        ? mergeOpenRouterProviderConfigParams(previousRecord, nextRecord)
        : value;
  }
  return merged;
}

function resolveOpenRouterProviderConfigParams(
  ctx: OpenRouterExtraParamsContext,
): Record<string, unknown> | undefined {
  const requestedProvider = ctx.provider.trim();
  const normalizedProvider = normalizeProviderId(requestedProvider);
  if (!normalizedProvider) {
    return undefined;
  }

  const providers = Object.entries(ctx.config?.models?.providers ?? {});
  const exactKey = providers.find(([provider]) => provider.trim() === requestedProvider)?.[0];
  const fallbackKey = providers.find(
    ([provider]) => normalizeProviderId(provider) === normalizedProvider,
  )?.[0];
  const providerKey = (exactKey ?? fallbackKey)?.trim();
  if (!providerKey) {
    return undefined;
  }

  // Preserve routing split across normalized duplicates; merge nested params
  // field-wise while allowing later scalar settings to override earlier ones.
  let matchedParams: Record<string, unknown> | undefined;
  for (const [provider, config] of providers) {
    if (provider.trim() !== providerKey) {
      continue;
    }
    const params = readRecord(config.params);
    if (params) {
      matchedParams = mergeOpenRouterProviderConfigParams(matchedParams, params);
    }
  }
  return matchedParams;
}

function mergeOpenRouterProviderRouting(params: {
  providerParams?: Record<string, unknown>;
  modelParams?: Record<string, unknown>;
  extraParams: Record<string, unknown>;
}): Record<string, unknown> | undefined {
  const providerRouting = readRecord(params.providerParams?.provider);
  const modelRouting = readRecord(params.modelParams?.provider);
  const extraRouting = readRecord(params.extraParams.provider);
  const merged = {
    ...providerRouting,
    ...modelRouting,
    ...extraRouting,
  };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

export function resolveOpenRouterExtraParamsForTransport(
  ctx: OpenRouterExtraParamsContext,
): { patch?: Record<string, unknown> } | undefined {
  const providerConfigParams = resolveOpenRouterProviderConfigParams(ctx);
  const modelParams = readRecord(ctx.model?.params);
  const providerRouting = mergeOpenRouterProviderRouting({
    providerParams: providerConfigParams,
    modelParams,
    extraParams: ctx.extraParams,
  });
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
