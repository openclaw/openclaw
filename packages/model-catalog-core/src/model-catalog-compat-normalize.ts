import { asFiniteNumber as normalizeFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  normalizeOptionalTrimmedStringList,
  normalizeTrimmedStringList,
} from "@openclaw/normalization-core/string-normalization";
import { normalizeCatalogFields } from "./model-catalog-normalize-fields.js";
import {
  isModelCatalogThinkingFormat,
  type ModelCatalogCompatConfig,
  type ModelCatalogOpenRouterRouting,
  type ModelCatalogVercelGatewayRouting,
} from "./model-catalog-types.js";

function normalizeOpenRouterPrice(value: unknown): ModelCatalogOpenRouterRouting["max_price"] {
  if (!isRecord(value)) {
    return undefined;
  }
  const maxPrice = normalizeCatalogFields(
    ["prompt", "completion", "image", "audio", "request"],
    (field) => {
      const candidate = value[field];
      return normalizeOptionalString(candidate) ?? normalizeFiniteNumber(candidate);
    },
  );
  return Object.keys(maxPrice).length > 0 ? maxPrice : undefined;
}

function normalizeOpenRouterMetricPreference(
  value: unknown,
): ModelCatalogOpenRouterRouting["preferred_min_throughput"] {
  const numeric = normalizeFiniteNumber(value);
  if (numeric !== undefined) {
    return numeric;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const normalized = normalizeCatalogFields(["p50", "p75", "p90", "p99"], (field) =>
    normalizeFiniteNumber(value[field]),
  );
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeOpenRouterSort(value: unknown): ModelCatalogOpenRouterRouting["sort"] {
  const sort = normalizeOptionalString(value);
  if (sort) {
    return sort;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const by = normalizeOptionalString(value.by);
  const partition =
    value.partition === null ? null : (normalizeOptionalString(value.partition) ?? undefined);
  const normalized = {
    ...(by ? { by } : {}),
    ...(partition !== undefined ? { partition } : {}),
  } satisfies NonNullable<Exclude<ModelCatalogOpenRouterRouting["sort"], string>>;
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeOpenRouterRouting(value: unknown): ModelCatalogOpenRouterRouting | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const routing: ModelCatalogOpenRouterRouting = {
    ...(typeof value.allow_fallbacks === "boolean"
      ? { allow_fallbacks: value.allow_fallbacks }
      : {}),
    ...(typeof value.require_parameters === "boolean"
      ? { require_parameters: value.require_parameters }
      : {}),
    ...(value.data_collection === "deny" || value.data_collection === "allow"
      ? { data_collection: value.data_collection }
      : {}),
    ...(typeof value.zdr === "boolean" ? { zdr: value.zdr } : {}),
    ...(typeof value.enforce_distillable_text === "boolean"
      ? { enforce_distillable_text: value.enforce_distillable_text }
      : {}),
  };
  normalizeCatalogFields(
    ["order", "only", "ignore", "quantizations"],
    (field) => normalizeOptionalTrimmedStringList(value[field]),
    routing,
  );
  const sort = normalizeOpenRouterSort(value.sort);
  if (sort) {
    routing.sort = sort;
  }
  const maxPrice = normalizeOpenRouterPrice(value.max_price);
  if (maxPrice) {
    routing.max_price = maxPrice;
  }
  for (const field of ["preferred_min_throughput", "preferred_max_latency"] as const) {
    const normalized = normalizeOpenRouterMetricPreference(value[field]);
    if (normalized !== undefined) {
      routing[field] = normalized;
    }
  }
  return Object.keys(routing).length > 0 ? routing : undefined;
}

function normalizeVercelGatewayRouting(
  value: unknown,
): ModelCatalogVercelGatewayRouting | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const routing = normalizeCatalogFields(["only", "order"], (field) =>
    normalizeOptionalTrimmedStringList(value[field]),
  );
  return Object.keys(routing).length > 0 ? routing : undefined;
}

/** Normalize a catalog row's `compat` block, including its OpenRouter and Vercel routing. */
export function normalizeModelCatalogCompat(value: unknown): ModelCatalogCompatConfig | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const compat: ModelCatalogCompatConfig = {};
  const booleanFields = [
    "supportsStore",
    "supportsPromptCacheKey",
    "supportsDeveloperRole",
    "supportsReasoningEffort",
    "supportsTemperature",
    "supportsInstructions",
    "cachesInstructions",
    "supportsUsageInStreaming",
    "supportsTools",
    "supportsStrictMode",
    "supportsJsonSchemaResponseFormat",
    "requiresStringContent",
    "strictMessageKeys",
    "requiresToolResultName",
    "requiresAssistantAfterToolResult",
    "requiresThinkingAsText",
    "requiresReasoningContentOnAssistantMessages",
    "zaiToolStream",
    "sendSessionAffinityHeaders",
    "sendSessionIdHeader",
    "supportsEagerToolInputStreaming",
    "supportsLongCacheRetention",
    "supportsResponsesContinuation",
    "requiresOpenAiAnthropicToolPayload",
    "adaptiveThinking",
    "thinkingRequired",
    "emitsDsmlToolCalls",
    "emitsReasoningInContent",
    "requiresTypedUnionBranches",
    "requiresNonEmptyUserOrAssistantMessage",
    "cacheControlSystemOnly",
    "cacheControlSharedSystem",
  ] as const;
  for (const field of booleanFields) {
    if (typeof value[field] === "boolean") {
      compat[field] = value[field];
    }
  }

  normalizeCatalogFields(
    ["toolSchemaProfile", "toolCallArgumentsEncoding", "defaultThinkingLevel"],
    (field) => normalizeOptionalString(value[field]),
    compat,
  );

  const stringListFields = [
    "visibleReasoningDetailTypes",
    "supportedReasoningEfforts",
    "unsupportedToolSchemaKeywords",
    "thinkingLevels",
  ] as const;
  for (const field of stringListFields) {
    const normalized = normalizeTrimmedStringList(value[field]);
    if (
      normalized.length > 0 ||
      (field === "supportedReasoningEfforts" && Array.isArray(value[field]))
    ) {
      compat[field] = normalized;
    }
  }

  if (isRecord(value.reasoningEffortMap)) {
    const reasoningEffortMap = Object.fromEntries(
      Object.entries(value.reasoningEffortMap).flatMap(([rawKey, rawMapped]) => {
        const key = rawKey.trim();
        const mapped = typeof rawMapped === "string" ? rawMapped.trim() : "";
        return key && mapped ? [[key, mapped]] : [];
      }),
    );
    if (Object.keys(reasoningEffortMap).length > 0) {
      compat.reasoningEffortMap = reasoningEffortMap;
    }
  }

  if (isRecord(value.thinkingLevelLabels)) {
    const labels = Object.fromEntries(
      Object.entries(value.thinkingLevelLabels).flatMap(([level, label]) =>
        typeof label === "string" && label.trim() ? [[level.trim(), label.trim()]] : [],
      ),
    );
    if (Object.keys(labels).length > 0) {
      compat.thinkingLevelLabels = labels;
    }
  }

  const codeMode = normalizeOptionalString(value.codeMode) ?? "";
  if (codeMode === "preferred" || codeMode === "capable") {
    compat.codeMode = codeMode;
  }

  const maxTokensField = normalizeOptionalString(value.maxTokensField) ?? "";
  if (maxTokensField === "max_completion_tokens" || maxTokensField === "max_tokens") {
    compat.maxTokensField = maxTokensField;
  }
  if (value.seedField === "seed" || value.seedField === "random_seed") {
    compat.seedField = value.seedField;
  }

  const thinkingFormat = normalizeOptionalString(value.thinkingFormat) ?? "";
  if (isModelCatalogThinkingFormat(thinkingFormat)) {
    compat.thinkingFormat = thinkingFormat;
  }

  if (value.cacheControlFormat === "anthropic") {
    compat.cacheControlFormat = "anthropic";
  }

  const openRouterRouting = normalizeOpenRouterRouting(value.openRouterRouting);
  if (openRouterRouting) {
    compat.openRouterRouting = openRouterRouting;
  }

  const vercelGatewayRouting = normalizeVercelGatewayRouting(value.vercelGatewayRouting);
  if (vercelGatewayRouting) {
    compat.vercelGatewayRouting = vercelGatewayRouting;
  }

  return Object.keys(compat).length > 0 ? compat : undefined;
}
