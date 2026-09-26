import type { ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";
/**
 * Static Anthropic Vertex model catalog builder. It derives provider base URLs
 * from region configuration and publishes Claude model metadata.
 */
import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import {
  modelCostsEqual,
  resolveClaudeFable5ModelIdentity,
  resolveClaudeMythos5ModelIdentity,
  resolveClaudeOpus5ModelIdentity,
  resolveClaudeSonnet5ModelIdentity,
} from "openclaw/plugin-sdk/provider-model-shared";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  resolveAnthropicVertexBaseUrl,
  resolveAnthropicVertexClientRegion,
} from "./region-endpoint.js";
import { resolveAnthropicVertexRegion } from "./region.js";
/** Default Anthropic Vertex model used for implicit provider catalogs. */
export const ANTHROPIC_VERTEX_DEFAULT_MODEL_ID = "claude-sonnet-4-6";
const ANTHROPIC_VERTEX_DEFAULT_CONTEXT_WINDOW = 1_000_000;
const ANTHROPIC_VERTEX_CLAUDE_5_MAX_TOKENS = 128_000;
const CLAUDE_5_SUPPORTED_REGIONS = new Set(["global", "us", "eu"]);
const GCP_VERTEX_CREDENTIALS_MARKER = "gcp-vertex-credentials";

const OPUS_5_COST = {
  global: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  multiRegion: { input: 5.5, output: 27.5, cacheRead: 0.55, cacheWrite: 6.875 },
} as const;

// Google's current table retains these rates beyond September 1, 2026 (5-minute cache writes).
// https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing#anthropics-claude-models
const SONNET_5_COST = {
  global: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  multiRegion: { input: 2.2, output: 11, cacheRead: 0.22, cacheWrite: 2.75 },
} as const;

function buildAnthropicVertexModel(
  params: Pick<ModelDefinitionConfig, "id" | "name" | "cost" | "mediaInput" | "thinkingLevelMap">,
) {
  return {
    ...params,
    reasoning: true,
    input: ["text", "image"],
    contextWindow: ANTHROPIC_VERTEX_DEFAULT_CONTEXT_WINDOW,
    maxTokens: ANTHROPIC_VERTEX_CLAUDE_5_MAX_TOKENS,
  } satisfies ModelDefinitionConfig;
}

function resolveClaude5Cost(
  region: string,
  costs: typeof OPUS_5_COST | typeof SONNET_5_COST,
): ProviderRuntimeModel["cost"] | undefined {
  const normalizedRegion = normalizeLowercaseStringOrEmpty(region);
  return CLAUDE_5_SUPPORTED_REGIONS.has(normalizedRegion)
    ? costs[normalizedRegion === "global" ? "global" : "multiRegion"]
    : undefined;
}

function buildAnthropicVertexCatalog(region: string) {
  const opus5Cost = resolveClaude5Cost(region, OPUS_5_COST);
  const opus5 = opus5Cost
    ? [
        buildAnthropicVertexModel({
          id: "claude-opus-5",
          name: "Claude Opus 5",
          cost: opus5Cost,
          mediaInput: {
            image: { maxSidePx: 2576, preferredSidePx: 2576, tokenMode: "provider" },
          },
          thinkingLevelMap: { xhigh: "xhigh", max: "max" },
        }),
      ]
    : [];
  const sonnet5Cost = resolveClaude5Cost(region, SONNET_5_COST);
  const sonnet5 = sonnet5Cost
    ? [
        buildAnthropicVertexModel({
          id: "claude-sonnet-5",
          name: "Claude Sonnet 5",
          cost: sonnet5Cost,
          mediaInput: {
            image: { maxSidePx: 2576, preferredSidePx: 2576, tokenMode: "provider" },
          },
          thinkingLevelMap: { xhigh: "xhigh", max: "max" },
        }),
      ]
    : [];
  return [
    buildAnthropicVertexModel({
      id: "claude-fable-5",
      name: "Claude Fable 5",
      cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
      thinkingLevelMap: { off: "low", minimal: "low", xhigh: "xhigh", max: "max" },
    }),
    ...opus5,
    buildAnthropicVertexModel({
      id: "claude-mythos-5",
      name: "Claude Mythos 5",
      cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
      thinkingLevelMap: { off: "low", minimal: "low", xhigh: "xhigh", max: "max" },
    }),
    ...sonnet5,
    buildAnthropicVertexModel({
      id: "claude-opus-4-8",
      name: "Claude Opus 4.8",
      cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
      thinkingLevelMap: { xhigh: "xhigh", max: "max" },
    }),
    buildAnthropicVertexModel({
      id: "claude-opus-4-6",
      name: "Claude Opus 4.6",
      cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
      thinkingLevelMap: { xhigh: null, max: "max" },
    }),
    buildAnthropicVertexModel({
      id: ANTHROPIC_VERTEX_DEFAULT_MODEL_ID,
      name: "Claude Sonnet 4.6",
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      thinkingLevelMap: { xhigh: null, max: "max" },
    }),
  ];
}
/** Resolve a missing runtime row using the same regional inventory as discovery. */
export function resolveAnthropicVertexDynamicModel(
  modelId: string,
  baseUrl?: string,
): ProviderRuntimeModel | undefined {
  const endpoint = normalizeOptionalString(baseUrl) ?? resolveAnthropicVertexBaseUrl();
  const region = resolveAnthropicVertexClientRegion({ baseUrl: endpoint });
  const model = buildAnthropicVertexCatalog(region).find((entry) => entry.id === modelId);
  return model
    ? { ...model, provider: "anthropic-vertex", api: "anthropic-messages", baseUrl: endpoint }
    : undefined;
}

/** Restore required generation metadata after explicit models replace an implicit row. */
export function normalizeAnthropicVertexResolvedModel(
  modelId: string,
  model: ProviderRuntimeModel,
): ProviderRuntimeModel | undefined {
  const ref = { id: modelId, params: model.params };
  const fable5 = resolveClaudeFable5ModelIdentity(ref) !== undefined;
  const mythos5 = resolveClaudeMythos5ModelIdentity(ref) !== undefined;
  const opus5 = resolveClaudeOpus5ModelIdentity(ref) !== undefined;
  const sonnet5 = resolveClaudeSonnet5ModelIdentity(ref) !== undefined;
  if (!fable5 && !mythos5 && !opus5 && !sonnet5) {
    return undefined;
  }
  const input: ProviderRuntimeModel["input"] = model.input.includes("image")
    ? model.input
    : [...model.input, "image"];
  const nativeThinkingLevelMap = {
    ...(fable5 || mythos5 ? { off: "low" as const, minimal: "low" as const } : {}),
    xhigh: "xhigh",
    max: "max",
  };
  const thinkingLevelMap = {
    ...nativeThinkingLevelMap,
    ...model.thinkingLevelMap,
  };
  const nativeThinkingLevelsMatch =
    model.thinkingLevelMap?.xhigh === "xhigh" &&
    model.thinkingLevelMap.max === "max" &&
    (!(fable5 || mythos5) ||
      (model.thinkingLevelMap.off === "low" && model.thinkingLevelMap.minimal === "low"));
  const region = resolveAnthropicVertexClientRegion({ baseUrl: model.baseUrl });
  const cost = opus5
    ? resolveClaude5Cost(region, OPUS_5_COST)
    : sonnet5
      ? resolveClaude5Cost(region, SONNET_5_COST)
      : undefined;
  const costMatches = !cost || modelCostsEqual(model.cost, cost);
  if (
    model.reasoning &&
    input === model.input &&
    model.contextWindow === ANTHROPIC_VERTEX_DEFAULT_CONTEXT_WINDOW &&
    model.contextTokens === ANTHROPIC_VERTEX_DEFAULT_CONTEXT_WINDOW &&
    (model.maxTokens ?? 0) >= ANTHROPIC_VERTEX_CLAUDE_5_MAX_TOKENS &&
    nativeThinkingLevelsMatch &&
    costMatches
  ) {
    return undefined;
  }
  return {
    ...model,
    reasoning: true,
    input,
    contextWindow: ANTHROPIC_VERTEX_DEFAULT_CONTEXT_WINDOW,
    contextTokens: ANTHROPIC_VERTEX_DEFAULT_CONTEXT_WINDOW,
    maxTokens: Math.max(model.maxTokens ?? 0, ANTHROPIC_VERTEX_CLAUDE_5_MAX_TOKENS),
    thinkingLevelMap,
    ...(cost ? { cost } : {}),
  };
}

/** Build the implicit Anthropic Vertex provider config for the current env. */
export function buildAnthropicVertexProvider(params?: {
  env?: NodeJS.ProcessEnv;
  // Ignored: pricing is time-independent. Retained for the v2026.8.1 public API;
  // remove only in a breaking API release.
  nowMs?: number;
}): ModelProviderConfig {
  const region = resolveAnthropicVertexRegion(params?.env);
  const baseUrl = resolveAnthropicVertexBaseUrl(params?.env);

  return {
    baseUrl,
    api: "anthropic-messages",
    apiKey: GCP_VERTEX_CREDENTIALS_MARKER,
    models: buildAnthropicVertexCatalog(region),
  };
}
