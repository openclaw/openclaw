import type { ProviderRuntimeModel } from "../plugins/provider-runtime-model.types.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";

// Defaults for agent metadata when upstream does not supply them.
// Keep this aligned with the product-level latest-model baseline.
export const DEFAULT_PROVIDER = "openai";
export const DEFAULT_MODEL = "gpt-6-astra";
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
  contextWindow?: number;
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
    contextWindow: params.contextWindow ?? DEFAULT_CONTEXT_TOKENS,
    maxTokens: DEFAULT_CONTEXT_TOKENS,
  };
}

/**
 * Returns the structural model when the selected plugin harness lists this exact model itself.
 * Native rows carry no host transport, so host model resolution cannot materialize them.
 */
export function resolveNativeOwnedRuntimeModel(params: {
  catalog: Pick<ModelCatalogSnapshot, "entries" | "routeVariants" | "staticEntries"> | undefined;
  provider: string;
  modelId: string;
  runtimeId: string | undefined;
}): ProviderRuntimeModel | undefined {
  const { catalog, provider, modelId, runtimeId } = params;
  if (!catalog || !runtimeId || runtimeId === "openclaw") {
    return undefined;
  }
  type Entry = ModelCatalogSnapshot["entries"][number];
  const sameModel = (entry: Entry) => entry.provider === provider && entry.id === modelId;
  const owned = (entry: Entry) => sameModel(entry) && entry.nativeRuntime === runtimeId;
  const rows = [...catalog.entries, ...catalog.routeVariants];
  const ownedRow = rows.find(owned);
  if (!ownedRow) {
    return undefined;
  }
  // Native rows rarely know their window; the provider's row for the same model does.
  const windowOf = (entry: Entry | undefined) =>
    entry?.contextWindowSource === "synthetic" ? undefined : entry?.contextWindow;
  const donor = [...rows, ...(catalog.staticEntries ?? [])].find(
    (entry) =>
      sameModel(entry) && entry.nativeRuntime === undefined && windowOf(entry) !== undefined,
  );
  const contextWindow = windowOf(ownedRow) ?? windowOf(donor);
  return createNativeModelOwnedRuntimeModel({ provider, modelId, contextWindow });
}
