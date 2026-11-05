import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  MODEL_DATA_APIS,
  MODEL_DATA_THINKING_FORMATS,
  MODEL_DATA_THINKING_LEVELS,
  type ModelDataCostRates,
  type ModelDataImageInputConfig,
  type ModelDataMediaInputConfig,
  type ModelDataRawPricingTier,
  type ModelDataThinkingLevelMap,
  type ModelRoutingMaxPrice,
  type ModelRoutingPercentiles,
  type ModelRoutingSortConfig,
} from "../../llm-core/src/model-data.js";
import type { ModelInferenceCapabilities } from "./model-inference-capabilities.js";

export type { DecisionAnswerCapabilities } from "./decision-answer-capabilities.js";

export type {
  ModelInferenceCapabilities,
  ModelDecisionCapabilities,
} from "./model-inference-capabilities.js";

// Tier capacity is separate from the model's full context window. Leave room
// below the observed serving boundary for output and tool-round growth.
const OPENAI_ULTRAFAST_CONTEXT_TOKENS = 260_000;

/** Prompt capacity for models served through a context-limited processing tier. */
export function resolveModelServiceTierContextTokens(
  provider: string | undefined,
  serviceTier: string | undefined,
): number | undefined {
  return provider === "openai" && serviceTier === "ultrafast"
    ? OPENAI_ULTRAFAST_CONTEXT_TOKENS
    : undefined;
}

export const MODEL_CATALOG_APIS = [...MODEL_DATA_APIS] as const;

export type ModelCatalogApi = (typeof MODEL_CATALOG_APIS)[number];

export const MODEL_CATALOG_THINKING_FORMATS = [...MODEL_DATA_THINKING_FORMATS] as const;

export type ModelCatalogThinkingFormat = (typeof MODEL_CATALOG_THINKING_FORMATS)[number];

export function isModelCatalogThinkingFormat(value: string): value is ModelCatalogThinkingFormat {
  return (MODEL_CATALOG_THINKING_FORMATS as readonly string[]).includes(value);
}

export type ModelCatalogCompatConfig = {
  supportsStore?: boolean;
  supportsDeveloperRole?: boolean;
  supportsReasoningEffort?: boolean;
  /** Whether the model accepts the temperature parameter (GPT-5.6 family rejects it). */
  supportsTemperature?: boolean;
  /** Whether the provider honors top-level `instructions` on Responses requests. */
  supportsInstructions?: boolean;
  supportsUsageInStreaming?: boolean;
  supportsStrictMode?: boolean;
  supportsJsonSchemaResponseFormat?: boolean;
  maxTokensField?: "max_completion_tokens" | "max_tokens";
  requiresToolResultName?: boolean;
  requiresAssistantAfterToolResult?: boolean;
  requiresThinkingAsText?: boolean;
  requiresReasoningContentOnAssistantMessages?: boolean;
  openRouterRouting?: ModelCatalogOpenRouterRouting;
  vercelGatewayRouting?: ModelCatalogVercelGatewayRouting;
  zaiToolStream?: boolean;
  cacheControlFormat?: "anthropic";
  sendSessionAffinityHeaders?: boolean;
  sendSessionIdHeader?: boolean;
  supportsEagerToolInputStreaming?: boolean;
  supportsLongCacheRetention?: boolean;
  supportsPromptCacheKey?: boolean;
  /** Explicit per-model opt-in for HTTP continuation on a custom/proxy OpenAI-Responses-compatible endpoint. */
  supportsResponsesContinuation?: boolean;
  supportsTools?: boolean;
  /** Code-mode tier consumed by `tools.codeMode.enabled: "auto"`; absent means "capable". */
  codeMode?: "preferred" | "capable";
  requiresStringContent?: boolean;
  strictMessageKeys?: boolean;
  toolSchemaProfile?: string;
  unsupportedToolSchemaKeywords?: string[];
  toolCallArgumentsEncoding?: string;
  requiresOpenAiAnthropicToolPayload?: boolean;
  thinkingFormat?: ModelCatalogThinkingFormat;
  supportedReasoningEfforts?: string[];
  reasoningEffortMap?: Record<string, string>;
  visibleReasoningDetailTypes?: string[];
  /** Thinking level a new session starts at. Its presence makes the row own the thinking profile. */
  defaultThinkingLevel?: string;
  /** Offered thinking levels, in order. Replaces the ladder derived from the map and efforts. */
  thinkingLevels?: string[];
  /** Offers the `adaptive` level, which lets the model choose its own effort. */
  adaptiveThinking?: boolean;
  /** Thinking stays on even when the row says `reasoning: false` (the route cannot turn it off). */
  thinkingRequired?: boolean;
  /** Display labels per level, e.g. `{ low: "on" }` for a binary thinking switch. */
  thinkingLevelLabels?: Record<string, string>;
};

/** OpenRouter routing preferences copied into request metadata. */
export type ModelCatalogOpenRouterRouting = {
  allow_fallbacks?: boolean;
  require_parameters?: boolean;
  data_collection?: "deny" | "allow";
  zdr?: boolean;
  enforce_distillable_text?: boolean;
  order?: string[];
  only?: string[];
  ignore?: string[];
  quantizations?: string[];
  sort?: string | ModelRoutingSortConfig;
  max_price?: ModelRoutingMaxPrice;
  preferred_min_throughput?: number | ModelRoutingPercentiles;
  preferred_max_latency?: number | ModelRoutingPercentiles;
};

export type ModelCatalogVercelGatewayRouting = {
  only?: string[];
  order?: string[];
};

export type ModelCatalogImageInputConfig = ModelDataImageInputConfig;

export type ModelCatalogMediaInputConfig = ModelDataMediaInputConfig;

// Lowercase, hyphen-separated token; the Gateway protocol's ModelChoice schema mirrors it.
const MODEL_FAMILY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const MODEL_FAMILY_MAX_LENGTH = 64;

/**
 * Canonical model family: the developer lineage a catalog declares for a model, such as
 * `anthropic`. Callers pass only provider or catalog metadata, never a model id or name.
 */
export function normalizeModelFamily(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const family = value.trim().toLowerCase();
  return family.length <= MODEL_FAMILY_MAX_LENGTH && MODEL_FAMILY_PATTERN.test(family)
    ? family
    : undefined;
}

export const MODEL_CATALOG_INPUTS = ["text", "image", "video", "document"] as const;
export type ModelCatalogInput = (typeof MODEL_CATALOG_INPUTS)[number];
export const MODEL_CATALOG_THINKING_LEVELS = [...MODEL_DATA_THINKING_LEVELS] as const;
export type ModelCatalogThinkingLevel = (typeof MODEL_CATALOG_THINKING_LEVELS)[number];
export type ModelCatalogThinkingLevelMap = ModelDataThinkingLevelMap;

const OPENAI_THINKING_APIS = new Set([
  "openai-completions",
  "openai-responses",
  "openai-chatgpt-responses",
  "azure-openai-responses",
]);

/** Managed API aliases retain the source adapter's reasoning contract. */
export function resolveOpenAIThinkingApi(api: unknown): string | undefined {
  if (typeof api !== "string") {
    return undefined;
  }
  const sourceApi = api.replace(/^openclaw-(.+)-transport$/u, "$1");
  return OPENAI_THINKING_APIS.has(sourceApi) ? sourceApi : undefined;
}

/** Map keys describe logical choices; provider-native values retain their spelling. */
/** A row owns its thinking profile when it states a default level or an offered ladder. */
export function ownsThinkingProfile(
  compat: { defaultThinkingLevel?: string; thinkingLevels?: readonly string[] } | null | undefined,
): boolean {
  return compat?.defaultThinkingLevel !== undefined || (compat?.thinkingLevels?.length ?? 0) > 0;
}

export function listMappedModelThinkingLevels(model: {
  api?: string | null;
  compat?: unknown;
}): ModelCatalogThinkingLevel[] {
  const compat = asOptionalRecord(model.compat);
  const efforts = compat?.supportedReasoningEfforts;
  const api = resolveOpenAIThinkingApi(model.api);
  const format = compat?.thinkingFormat;
  const binaryOnly = format === "qwen" || format === "qwen-chat-template" || format === "zai";
  if (
    !api ||
    (api === "openai-completions" && binaryOnly) ||
    compat?.supportsReasoningEffort === false ||
    (Array.isArray(efforts) && efforts.length === 0)
  ) {
    return [];
  }
  const mapping = asOptionalRecord(compat?.reasoningEffortMap);
  const mapped = new Set(
    Object.entries(mapping ?? {}).flatMap(([level, effort]) =>
      typeof effort === "string" && effort.trim() ? [level.trim().toLowerCase()] : [],
    ),
  );
  return MODEL_CATALOG_THINKING_LEVELS.filter((level) => mapped.has(level));
}

export type ModelCatalogDiscovery = "static" | "refreshable" | "runtime";
export const MODEL_CATALOG_STATUSES = ["available", "preview", "deprecated", "disabled"] as const;
export type ModelCatalogStatus = (typeof MODEL_CATALOG_STATUSES)[number];
export type ModelCatalogSource =
  | "manifest"
  | "provider-index"
  | "cache"
  | "config"
  | "runtime-refresh";

export type UnifiedModelCatalogKind =
  | "text"
  | "voice"
  | "image_generation"
  | "video_generation"
  | "music_generation";

export type UnifiedModelCatalogSource =
  | "manifest"
  | "provider-index"
  | "static"
  | "live"
  | "cache"
  | "configured"
  | "runtime-refresh";

/** Unified model catalog entry for provider/model pickers. */
export type UnifiedModelCatalogEntry<TCapabilities = unknown> = {
  kind: UnifiedModelCatalogKind;
  provider: string;
  model: string;
  label?: string;
  source: UnifiedModelCatalogSource;
  default?: boolean;
  configured?: boolean;
  capabilities?: TCapabilities;
  modes?: readonly string[];
  authEnvVars?: readonly string[];
  docsPath?: string;
  fetchedAt?: number;
  expiresAt?: number;
  warnings?: readonly string[];
};

export type ModelCatalogTieredCost = ModelDataRawPricingTier;

export type ModelCatalogCost = Partial<ModelDataCostRates> & {
  tieredPricing?: ModelCatalogTieredCost[];
};

/** Bounded provider-declared context-window choice for one model. */
export type ModelCatalogContextWindowOption = {
  id: string;
  label: string;
  contextWindow: number;
};

export const MODEL_CATALOG_MAX_CONTEXT_WINDOWS = 16;

export type ModelCatalogModel = {
  id: string;
  /** Task facts for this exact served route, independent of chat wire metadata. */
  inference?: ModelInferenceCapabilities;
  name?: string;
  api?: ModelCatalogApi;
  baseUrl?: string;
  headers?: Record<string, string>;
  input?: ModelCatalogInput[];
  reasoning?: boolean;
  contextWindow?: number;
  contextWindows?: ModelCatalogContextWindowOption[];
  contextWindowDefault?: string;
  contextTokens?: number;
  /** Total model parameters, including inactive experts. */
  parameterCount?: number;
  /** Canonical developer lineage of this model; overrides the provider-level family. */
  family?: string;
  maxTokens?: number;
  thinkingLevelMap?: ModelCatalogThinkingLevelMap;
  cost?: ModelCatalogCost;
  compat?: ModelCatalogCompatConfig;
  /**
   * Provider/model ref of the same upstream model in another bundled catalog,
   * for vendors reachable through several provider ids under different model
   * ids. Authoring metadata only: normalization drops it, and the shared-model
   * contract test uses it to keep `compat` capability tiers from drifting apart.
   */
  upstreamModel?: string;
  mediaInput?: ModelCatalogMediaInputConfig;
  status?: ModelCatalogStatus;
  statusReason?: string;
  replaces?: string[];
  replacedBy?: string;
  tags?: string[];
};

export type ModelCatalogProvider = {
  /** Credential owner; omitted providers keep agent-owned profile/env/config auth. */
  authScope?: "agent" | "plugin";
  baseUrl?: string;
  api?: ModelCatalogApi;
  headers?: Record<string, string>;
  /**
   * Canonical family of every model in this provider's catalog, for single-developer
   * catalogs. Rows inherit it like `api`; multi-developer hosts declare it per row.
   */
  family?: string;
  /** Provider-recommended primary model id. */
  defaultModel?: string;
  /** Provider-recommended small model id for short internal utility tasks. */
  defaultUtilityModel?: string;
  /**
   * Multi-vendor routers: small model id per vendor, keyed by the vendor prefix of the
   * primary model id (`<vendor>/<model>`). Used only when the router offers that model.
   */
  defaultUtilityModels?: Record<string, string>;
  /**
   * Hosted catalog v2 projection of the curated global list onto this provider's
   * model ids, best first; reserved for picker ordering and not yet used.
   */
  recommendedModels?: string[];
  models: ModelCatalogModel[];
};

export type ModelCatalogAlias = {
  provider: string;
  api?: ModelCatalogApi;
  baseUrl?: string;
};

/** Suppression rule for hiding a provider/model under matching config. */
export type ModelCatalogSuppression = {
  provider: string;
  model: string;
  reason?: string;
  /** Explicit retirement and optional provider-local successor; otherwise doctor clears overrides. */
  retirement?: { replacedBy?: string };
  when?: {
    baseUrlHosts?: string[];
    providerConfigApiIn?: string[];
  };
};

/** Raw model catalog manifest shape. */
export type ModelCatalog = {
  /** Publication-time opt-in: owned OpenClaw provider id -> models.dev provider id. */
  modelsDev?: Record<string, string>;
  providers?: Record<string, ModelCatalogProvider>;
  aliases?: Record<string, ModelCatalogAlias>;
  suppressions?: ModelCatalogSuppression[];
  discovery?: Record<string, ModelCatalogDiscovery>;
  /** Runtime catalogs bound to the configured origin, or the manifest default when absent. */
  configuredEndpointDiscovery?: string[];
  runtimeAugment?: boolean;
};

/** Normalized model catalog row used by runtime lookup and UI surfaces. */
export type NormalizedModelCatalogRow = Omit<ModelCatalogModel, "upstreamModel"> & {
  provider: string;
  ref: string;
  mergeKey: string;
  name: string;
  source: ModelCatalogSource;
  input: ModelCatalogInput[];
  reasoning: boolean;
  status: ModelCatalogStatus;
};
