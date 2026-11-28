import type { ProviderRuntimeModel } from "../plugins/provider-runtime-model.types.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";

// Defaults for agent metadata when upstream does not supply them.
/**
 * Provider that qualifies a bare model id written without a provider (`gpt-6` → `openai/gpt-6`).
 * Parsers take it as `defaultProvider`; it never selects a model. No configured model means none.
 */
export const DEFAULT_PROVIDER = "openai";
// Conservative fallback used when model metadata is unavailable.
export const DEFAULT_CONTEXT_TOKENS = 200_000;
/** Output-token cap used when no authored, provider, or catalog limit exists. */
export const DEFAULT_MODEL_MAX_TOKENS = 32_768;
// The former fixed fallback. Small windows never resolve below it unless the window is smaller.
const DEFAULT_MODEL_MAX_TOKENS_FLOOR = 8_192;

/**
 * Resolves the invented output cap for a model whose real limit is unknown.
 * A known window keeps half its tokens for input, between the former 8192
 * fallback and the 32768 default, and never exceeds the window itself.
 * Explicit limits never pass through here.
 */
export function resolveDefaultModelMaxTokens(contextWindow?: number): number {
  if (contextWindow === undefined || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return DEFAULT_MODEL_MAX_TOKENS;
  }
  const window = Math.max(1, Math.floor(contextWindow));
  return Math.min(
    DEFAULT_MODEL_MAX_TOKENS,
    Math.max(Math.min(DEFAULT_MODEL_MAX_TOKENS_FLOOR, window), Math.floor(window / 2)),
  );
}

/** Builds structural model metadata for a harness that resolves its real model natively. */
export function createNativeModelOwnedRuntimeModel(params: {
  provider: string;
  modelId: string;
}): ProviderRuntimeModel {
  return {
    provider: params.provider,
    id: params.modelId,
    name: params.modelId,
    baseUrl: "",
    api: "openai-responses",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT_TOKENS,
    maxTokens: DEFAULT_CONTEXT_TOKENS,
  };
}

/** Native rows carry no host transport; supply structural metadata for their runtime. */
export function resolveNativeOwnedRuntimeModel(params: {
  catalog: Pick<ModelCatalogSnapshot, "entries" | "routeVariants"> | undefined;
  provider: string;
  modelId: string;
  runtimeId: string | undefined;
}): ProviderRuntimeModel | undefined {
  const { catalog, provider, modelId, runtimeId } = params;
  if (!catalog || !runtimeId || runtimeId === "openclaw") {
    return undefined;
  }
  const owned = (entry: ModelCatalogSnapshot["entries"][number]) =>
    entry.provider === provider && entry.id === modelId && entry.nativeRuntime === runtimeId;
  const entry = catalog.entries.find(owned) ?? catalog.routeVariants.find(owned);
  if (!entry) {
    return undefined;
  }
  const model = createNativeModelOwnedRuntimeModel({ provider, modelId });
  return {
    ...model,
    name: entry.name,
    reasoning: entry.reasoning ?? model.reasoning,
    input: entry.input?.filter((kind) => kind === "text" || kind === "image") ?? model.input,
    contextWindow: entry.contextWindow ?? model.contextWindow,
    maxTokens: entry.contextWindow
      ? resolveDefaultModelMaxTokens(entry.contextWindow)
      : model.maxTokens,
    ...(entry.contextTokens !== undefined ? { contextTokens: entry.contextTokens } : {}),
    ...(entry.contextWindows ? { contextWindows: entry.contextWindows } : {}),
    ...(entry.contextWindowDefault ? { contextWindowDefault: entry.contextWindowDefault } : {}),
    ...(entry.compat ? { compat: entry.compat } : {}),
    ...(entry.mediaInput ? { mediaInput: entry.mediaInput } : {}),
  };
}
