import type { ProviderPlugin } from "openclaw/plugin-sdk/plugin-entry";

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

export function resolveOpenRouterExtraParamsForTransport(
  ctx: Parameters<NonNullable<ProviderPlugin["extraParamsForTransport"]>>[0],
): { patch?: Record<string, unknown> } | undefined {
  const providerConfigParams = readRecord(ctx.config?.models?.providers?.[ctx.provider]?.params);
  const modelParams = readRecord(ctx.model?.params);
  const providerRouting = {
    ...readRecord(providerConfigParams?.provider),
    ...readRecord(modelParams?.provider),
    ...readRecord(ctx.extraParams.provider),
  };
  const hasProviderRouting = Object.keys(providerRouting).length > 0;
  if (!providerConfigParams && !modelParams && !hasProviderRouting) {
    return undefined;
  }
  return {
    patch: {
      ...providerConfigParams,
      ...modelParams,
      ...ctx.extraParams,
      ...(hasProviderRouting ? { provider: providerRouting } : {}),
    },
  };
}
