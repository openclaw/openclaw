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

/**
 * Reads the `models` array from provider or model params for OpenRouter's
 * automatic fallback feature. When provided, OpenRouter will try each model
 * in order if the primary is down, rate-limited, or returns an error.
 *
 * @see https://openrouter.ai/docs/guides/routing/model-fallbacks
 */
function resolveOpenRouterModelsArray(params: {
  providerParams?: Record<string, unknown>;
  modelParams?: Record<string, unknown>;
  extraParams: Record<string, unknown>;
}): string[] | undefined {
  const rawModels =
    params.extraParams.models ??
    params.providerParams?.models ??
    params.modelParams?.models;

  if (!Array.isArray(rawModels)) {
    return undefined;
  }

  const models = rawModels
    .map((entry) => (typeof entry === "string" ? entry.trim() : undefined))
    .filter((entry): entry is string => Boolean(entry));

  if (models.length === 0) {
    return undefined;
  }

  // Pass through all valid models — OpenRouter applies its own limits
  // server-side; adding a client-side cap silently drops configured
  // fallback candidates without a documented contract.
  return models;
}

export function resolveOpenRouterExtraParamsForTransport(
  ctx: OpenRouterExtraParamsContext,
): { patch?: Record<string, unknown> } | undefined {
  const providerConfigParams = readRecord(ctx.config?.models?.providers?.[ctx.provider]?.params);
  const modelParams = readRecord(ctx.model?.params);
  const providerRouting = mergeOpenRouterProviderRouting({
    providerParams: providerConfigParams,
    modelParams,
    extraParams: ctx.extraParams,
  });
  const modelsArray = resolveOpenRouterModelsArray({
    providerParams: providerConfigParams,
    modelParams,
    extraParams: ctx.extraParams,
  });
  if (!providerConfigParams && !modelParams && !providerRouting && !modelsArray) {
    return undefined;
  }
  // Start with merged params. Strip raw `models` from extraParams to prevent
  // non-array values (null, object, string, etc.) from leaking into the patch.
  const patch: Record<string, unknown> = {
    ...providerConfigParams,
    ...modelParams,
    ...Object.fromEntries(
      Object.entries(ctx.extraParams).filter(([k]) => k !== "models"),
    ),
    ...(providerRouting ? { provider: providerRouting } : {}),
  };
  // When a valid models array was resolved, inject it as the sole source of
  // truth. Otherwise explicitly remove any raw `models` that leaked through
  // from providerConfigParams or modelParams — invalid values must not be
  // forwarded to OpenRouter.
  if (modelsArray) {
    patch.models = modelsArray;
  } else {
    delete patch.models;
  }
  return { patch };
}
