import {
  asFiniteNumber as normalizeFiniteNumber,
  asNonNegativeFiniteNumber as normalizeNonNegativeNumber,
  asPositiveFiniteNumber as normalizePositiveNumber,
} from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  normalizeOptionalTrimmedStringList,
  normalizeTrimmedStringList,
} from "@openclaw/normalization-core/string-normalization";
import { normalizeModelCatalogContextWindowSelection } from "./model-catalog-context-windows.js";
import { buildModelCatalogMergeKey, buildModelCatalogRef } from "./model-catalog-refs.js";
import {
  MODEL_CATALOG_APIS,
  MODEL_CATALOG_THINKING_LEVELS,
  isModelCatalogThinkingFormat,
  type ModelCatalog,
  type ModelCatalogApi,
  type ModelCatalogCompatConfig,
  type ModelCatalogCost,
  type ModelCatalogDiscovery,
  type ModelCatalogImageInputConfig,
  type ModelCatalogInput,
  type ModelCatalogMediaInputConfig,
  type ModelCatalogModel,
  type ModelCatalogOpenRouterRouting,
  type ModelCatalogProvider,
  type ModelCatalogSource,
  type ModelCatalogStatus,
  type ModelCatalogSuppression,
  type ModelCatalogThinkingLevelMap,
  type ModelCatalogTieredCost,
  type ModelCatalogVercelGatewayRouting,
  type NormalizedModelCatalogRow,
} from "./model-catalog-types.js";
import { normalizeProviderId } from "./provider-id.js";
export { normalizeOpenRouterModelReasoning } from "./model-catalog-reasoning.js";

const MODEL_CATALOG_INPUTS = new Set(["text", "image", "document"]);
const MODEL_CATALOG_DISCOVERY_MODES = new Set(["static", "refreshable", "runtime"]);
const MODEL_CATALOG_STATUSES = new Set(["available", "preview", "deprecated", "disabled"]);
const MODEL_CATALOG_API_SET = new Set<string>(MODEL_CATALOG_APIS);
const DEFAULT_MODEL_INPUT: ModelCatalogInput[] = ["text"];
const DEFAULT_MODEL_STATUS: ModelCatalogStatus = "available";

/** Reject object keys that can mutate prototypes when copied into records. */
function isBlockedObjectKey(key: string): boolean {
  return key === "__proto__" || key === "prototype" || key === "constructor";
}

function normalizeModelCatalogThinkingLevelMap(
  value: unknown,
): ModelCatalogThinkingLevelMap | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const normalized = normalizeCatalogFields(MODEL_CATALOG_THINKING_LEVELS, (level) => {
    const mapped = value[level];
    return mapped === null ? null : normalizeOptionalString(mapped);
  });
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeStringMap(value: unknown): Record<string, string> | undefined {
  return normalizeCatalogRecords(
    value,
    (key, rawValue) => {
      const mapValue = normalizeOptionalString(rawValue) ?? "";
      return key && !isBlockedObjectKey(key) && mapValue ? mapValue : undefined;
    },
    (key) => normalizeOptionalString(key) ?? "",
  );
}

function normalizeCatalogFields<K extends string, V>(
  fields: readonly K[],
  normalize: (field: K) => V | undefined,
  result: Partial<Record<K, V>> = {},
): Partial<Record<K, V>> {
  for (const field of fields) {
    const value = normalize(field);
    if (value !== undefined) {
      result[field] = value;
    }
  }
  return result;
}

function normalizeModelCatalogApi(value: unknown): ModelCatalogApi | undefined {
  const api = normalizeOptionalString(value) ?? "";
  return MODEL_CATALOG_API_SET.has(api) ? (api as ModelCatalogApi) : undefined;
}

function normalizeModelCatalogInputs(value: unknown): ModelCatalogInput[] | undefined {
  const inputs = normalizeTrimmedStringList(value).filter((input): input is ModelCatalogInput =>
    MODEL_CATALOG_INPUTS.has(input),
  );
  return inputs.length > 0 ? inputs : undefined;
}

function normalizePositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function normalizeModelCatalogTieredCost(value: unknown): ModelCatalogTieredCost[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized: ModelCatalogTieredCost[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || !Array.isArray(entry.range)) {
      continue;
    }
    const input = normalizeNonNegativeNumber(entry.input);
    const output = normalizeNonNegativeNumber(entry.output);
    const cacheRead = normalizeNonNegativeNumber(entry.cacheRead);
    const cacheWrite = normalizeNonNegativeNumber(entry.cacheWrite);
    if (
      input === undefined ||
      output === undefined ||
      cacheRead === undefined ||
      cacheWrite === undefined ||
      entry.range.length < 1 ||
      entry.range.length > 2
    ) {
      continue;
    }
    const rangeValues = entry.range.map((rangeValue) => normalizeNonNegativeNumber(rangeValue));
    if (rangeValues.some((rangeValue) => rangeValue === undefined)) {
      continue;
    }
    normalized.push({
      input,
      output,
      cacheRead,
      cacheWrite,
      range:
        rangeValues.length === 1
          ? ([rangeValues[0]] as [number])
          : ([rangeValues[0], rangeValues[1]] as [number, number]),
    });
  }
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeModelCatalogCost(value: unknown): ModelCatalogCost | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const cost: ModelCatalogCost = normalizeCatalogFields(
    ["input", "output", "cacheRead", "cacheWrite"],
    (field) => normalizeNonNegativeNumber(value[field]),
  );
  const tieredPricing = normalizeModelCatalogTieredCost(value.tieredPricing);
  if (tieredPricing) {
    cost.tieredPricing = tieredPricing;
  }
  return Object.keys(cost).length > 0 ? cost : undefined;
}

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

function normalizeModelCatalogCompat(value: unknown): ModelCatalogCompatConfig | undefined {
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
  ] as const;
  for (const field of booleanFields) {
    if (typeof value[field] === "boolean") {
      compat[field] = value[field];
    }
  }

  normalizeCatalogFields(
    ["toolSchemaProfile", "toolCallArgumentsEncoding"],
    (field) => normalizeOptionalString(value[field]),
    compat,
  );

  const stringListFields = [
    "visibleReasoningDetailTypes",
    "supportedReasoningEfforts",
    "unsupportedToolSchemaKeywords",
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

  const codeMode = normalizeOptionalString(value.codeMode) ?? "";
  if (codeMode === "preferred" || codeMode === "capable") {
    compat.codeMode = codeMode;
  }

  const maxTokensField = normalizeOptionalString(value.maxTokensField) ?? "";
  if (maxTokensField === "max_completion_tokens" || maxTokensField === "max_tokens") {
    compat.maxTokensField = maxTokensField;
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

function normalizeModelCatalogStatus(value: unknown): ModelCatalogStatus | undefined {
  const status = normalizeOptionalString(value) ?? "";
  return MODEL_CATALOG_STATUSES.has(status) ? (status as ModelCatalogStatus) : undefined;
}

function normalizeModelCatalogImageTokenMode(
  value: unknown,
): ModelCatalogImageInputConfig["tokenMode"] {
  const tokenMode = normalizeOptionalString(value) ?? "";
  if (tokenMode === "tile" || tokenMode === "detail" || tokenMode === "provider") {
    return tokenMode;
  }
  return undefined;
}

function normalizeModelCatalogMediaInput(value: unknown): ModelCatalogMediaInputConfig | undefined {
  if (!isRecord(value) || !isRecord(value.image)) {
    return undefined;
  }
  const normalizedImage: ModelCatalogImageInputConfig = {};
  for (const field of ["maxBytes", "maxPixels", "maxSidePx", "preferredSidePx"] as const) {
    const normalized = normalizePositiveInteger(value.image[field]);
    if (normalized !== undefined) {
      normalizedImage[field] = normalized;
    }
  }
  const tokenMode = normalizeModelCatalogImageTokenMode(value.image.tokenMode);
  if (tokenMode) {
    normalizedImage.tokenMode = tokenMode;
  }
  return Object.keys(normalizedImage).length > 0 ? { image: normalizedImage } : undefined;
}

function normalizeModelCatalogModel(value: unknown): ModelCatalogModel | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = normalizeOptionalString(value.id) ?? "";
  if (!id) {
    return undefined;
  }
  const name = normalizeOptionalString(value.name) ?? "";
  const api = normalizeModelCatalogApi(value.api);
  const baseUrl = normalizeOptionalString(value.baseUrl) ?? "";
  const headers = normalizeStringMap(value.headers);
  const input = normalizeModelCatalogInputs(value.input);
  const reasoning = typeof value.reasoning === "boolean" ? value.reasoning : undefined;
  const contextWindow = normalizePositiveNumber(value.contextWindow);
  const contextWindowSelection = normalizeModelCatalogContextWindowSelection(value);
  const contextTokens = normalizePositiveInteger(value.contextTokens);
  const maxTokens = normalizePositiveNumber(value.maxTokens);
  const thinkingLevelMap = normalizeModelCatalogThinkingLevelMap(value.thinkingLevelMap);
  const cost = normalizeModelCatalogCost(value.cost);
  const compat = normalizeModelCatalogCompat(value.compat);
  const mediaInput = normalizeModelCatalogMediaInput(value.mediaInput);
  const status = normalizeModelCatalogStatus(value.status);
  const statusReason = normalizeOptionalString(value.statusReason) ?? "";
  const replaces = normalizeTrimmedStringList(value.replaces);
  const replacedBy = normalizeOptionalString(value.replacedBy) ?? "";
  const tags = normalizeTrimmedStringList(value.tags);
  return {
    id,
    ...(name ? { name } : {}),
    ...(api ? { api } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(headers ? { headers } : {}),
    ...(input ? { input } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...contextWindowSelection,
    ...(contextTokens !== undefined ? { contextTokens } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    ...(cost ? { cost } : {}),
    ...(compat ? { compat } : {}),
    ...(mediaInput ? { mediaInput } : {}),
    ...(status ? { status } : {}),
    ...(statusReason ? { statusReason } : {}),
    ...(replaces.length > 0 ? { replaces } : {}),
    ...(replacedBy ? { replacedBy } : {}),
    ...(tags.length > 0 ? { tags } : {}),
  };
}

function normalizeModelCatalogProvider(value: unknown): ModelCatalogProvider | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const models = Array.isArray(value.models)
    ? value.models
        .map((entry) => normalizeModelCatalogModel(entry))
        .filter((entry): entry is ModelCatalogModel => Boolean(entry))
    : [];
  if (models.length === 0) {
    return undefined;
  }
  const baseUrl = normalizeOptionalString(value.baseUrl) ?? "";
  const api = normalizeModelCatalogApi(value.api);
  const headers = normalizeStringMap(value.headers);
  const defaultModel = normalizeOptionalString(value.defaultModel) ?? "";
  const defaultUtilityModel = normalizeOptionalString(value.defaultUtilityModel) ?? "";
  return {
    ...(baseUrl ? { baseUrl } : {}),
    ...(api ? { api } : {}),
    ...(headers ? { headers } : {}),
    ...(defaultModel ? { defaultModel } : {}),
    ...(defaultUtilityModel ? { defaultUtilityModel } : {}),
    models,
  };
}

function normalizeCatalogRecords<T>(
  value: unknown,
  normalize: (key: string, value: unknown) => T | undefined,
  normalizeKey: (key: string) => string = normalizeProviderId,
): Record<string, T> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const records: Record<string, T> = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = normalizeKey(rawKey);
    const normalized = normalize(key, rawValue);
    if (normalized !== undefined) {
      records[key] = normalized;
    }
  }
  return Object.keys(records).length > 0 ? records : undefined;
}

function normalizeModelCatalogSuppressions(value: unknown): ModelCatalogSuppression[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const suppressions: ModelCatalogSuppression[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }
    const provider = normalizeProviderId(normalizeOptionalString(entry.provider) ?? "");
    const model = normalizeOptionalString(entry.model) ?? "";
    if (!provider || !model) {
      continue;
    }
    const reason = normalizeOptionalString(entry.reason) ?? "";
    const replacedBy = isRecord(entry.retirement)
      ? normalizeOptionalString(entry.retirement.replacedBy)
      : undefined;
    const retirement =
      isRecord(entry.retirement) && (entry.retirement.replacedBy === undefined || replacedBy)
        ? replacedBy
          ? { replacedBy }
          : {}
        : undefined;
    const rawWhen = isRecord(entry.when) ? entry.when : undefined;
    const baseUrlHosts = normalizeTrimmedStringList(rawWhen?.baseUrlHosts).map((host) =>
      host.toLowerCase(),
    );
    const providerConfigApiIn = normalizeTrimmedStringList(rawWhen?.providerConfigApiIn).map(
      (api) => api.toLowerCase(),
    );
    const when =
      baseUrlHosts.length > 0 || providerConfigApiIn.length > 0
        ? {
            ...(baseUrlHosts.length > 0 ? { baseUrlHosts } : {}),
            ...(providerConfigApiIn.length > 0 ? { providerConfigApiIn } : {}),
          }
        : undefined;
    // A malformed retirement scope must never broaden a persistent model repair.
    if (
      retirement &&
      entry.when !== undefined &&
      (!rawWhen ||
        !when ||
        (rawWhen.baseUrlHosts !== undefined && baseUrlHosts.length === 0) ||
        (rawWhen.providerConfigApiIn !== undefined && providerConfigApiIn.length === 0))
    ) {
      continue;
    }
    suppressions.push({
      provider,
      model,
      ...(reason ? { reason } : {}),
      ...(retirement ? { retirement } : {}),
      ...(when ? { when } : {}),
    });
  }
  return suppressions.length > 0 ? suppressions : undefined;
}

/** Normalize a raw model catalog object for the set of providers owned by a plugin/manifest. */
export function normalizeModelCatalog(
  value: unknown,
  params: { ownedProviders: ReadonlySet<string> },
): ModelCatalog | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const ownedProviders = new Set(
    [...params.ownedProviders].map(normalizeProviderId).filter(Boolean),
  );
  const modelsDev = Object.fromEntries(
    Object.entries(normalizeStringMap(value.modelsDev) ?? {}).flatMap(
      ([rawProviderId, sourceId]) => {
        const providerId = normalizeProviderId(rawProviderId);
        return ownedProviders.has(providerId) && !isBlockedObjectKey(providerId)
          ? [[providerId, sourceId] as const]
          : [];
      },
    ),
  );
  const providers = normalizeCatalogRecords(value.providers, (providerId, rawProvider) =>
    providerId && ownedProviders.has(providerId)
      ? normalizeModelCatalogProvider(rawProvider)
      : undefined,
  );
  const aliases = normalizeCatalogRecords(value.aliases, (alias, rawTarget) => {
    if (!alias || !isRecord(rawTarget)) {
      return undefined;
    }
    const provider = normalizeProviderId(normalizeOptionalString(rawTarget.provider) ?? "");
    if (!provider || !ownedProviders.has(provider)) {
      return undefined;
    }
    const api = normalizeModelCatalogApi(rawTarget.api);
    const baseUrl = normalizeOptionalString(rawTarget.baseUrl) ?? "";
    return {
      provider,
      ...(api ? { api } : {}),
      ...(baseUrl ? { baseUrl } : {}),
    };
  });
  const suppressions = normalizeModelCatalogSuppressions(value.suppressions);
  const discovery = normalizeCatalogRecords(value.discovery, (providerId, rawMode) => {
    const mode = normalizeOptionalString(rawMode) ?? "";
    return providerId && ownedProviders.has(providerId) && MODEL_CATALOG_DISCOVERY_MODES.has(mode)
      ? (mode as ModelCatalogDiscovery)
      : undefined;
  });
  const runtimeAugment = value.runtimeAugment === true;
  const catalog = {
    ...(Object.keys(modelsDev).length > 0 ? { modelsDev } : {}),
    ...(providers ? { providers } : {}),
    ...(aliases ? { aliases } : {}),
    ...(suppressions ? { suppressions } : {}),
    ...(discovery ? { discovery } : {}),
    ...(runtimeAugment ? { runtimeAugment } : {}),
  } satisfies ModelCatalog;
  return Object.keys(catalog).length > 0 ? catalog : undefined;
}

/** Normalize one provider catalog into sorted runtime rows. */
export function normalizeModelCatalogProviderRows(params: {
  provider: string;
  providerCatalog: ModelCatalogProvider;
  source: ModelCatalogSource;
}): NormalizedModelCatalogRow[] {
  const provider = normalizeProviderId(params.provider);
  if (!provider || !Array.isArray(params.providerCatalog.models)) {
    return [];
  }
  const providerApi = normalizeModelCatalogApi(params.providerCatalog.api);
  const providerBaseUrl = normalizeOptionalString(params.providerCatalog.baseUrl) ?? "";
  const providerHeaders = normalizeStringMap(params.providerCatalog.headers);
  const rows: NormalizedModelCatalogRow[] = [];

  for (const rawModel of params.providerCatalog.models) {
    const model = normalizeModelCatalogModel(rawModel);
    if (!model) {
      continue;
    }
    const api = model.api ?? providerApi;
    const baseUrl = model.baseUrl ?? providerBaseUrl;
    const headers =
      providerHeaders || model.headers ? { ...providerHeaders, ...model.headers } : undefined;
    rows.push({
      ...model,
      provider,
      ref: buildModelCatalogRef(provider, model.id),
      mergeKey: buildModelCatalogMergeKey(provider, model.id),
      name: model.name ?? model.id,
      source: params.source,
      input: model.input ?? [...DEFAULT_MODEL_INPUT],
      reasoning: model.reasoning ?? false,
      status: model.status ?? DEFAULT_MODEL_STATUS,
      ...(api ? { api } : {}),
      ...(baseUrl ? { baseUrl } : {}),
      ...(headers ? { headers } : {}),
    });
  }

  return rows.toSorted((a, b) => a.id.localeCompare(b.id));
}
