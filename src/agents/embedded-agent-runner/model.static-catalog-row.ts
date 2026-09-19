import { normalizeResolvedPricing } from "@openclaw/llm-core";
import type { NormalizedModelCatalogRow } from "@openclaw/model-catalog-core/model-catalog-types";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import { DEFAULT_CONTEXT_TOKENS } from "../defaults.js";

function normalizeStaticCatalogInput(
  input: readonly unknown[] | undefined,
): ProviderRuntimeModel["input"] {
  const normalizedInput = (input ?? []).filter(
    (item): item is "text" | "image" => item === "text" || item === "image",
  );
  return normalizedInput.length > 0 ? normalizedInput : ["text"];
}

/** Converts a normalized catalog row into the provider runtime model shape. */
export function modelFromStaticCatalogRow(row: NormalizedModelCatalogRow): ProviderRuntimeModel {
  return {
    id: row.id,
    name: row.name || row.id,
    provider: row.provider,
    api: row.api ?? "openai-responses",
    baseUrl: row.baseUrl ?? "",
    reasoning: row.reasoning,
    input: normalizeStaticCatalogInput(row.input),
    cost: normalizeResolvedPricing(row.cost ?? {}),
    contextWindow: row.contextWindow ?? DEFAULT_CONTEXT_TOKENS,
    contextWindows: row.contextWindows?.map((option) => ({ ...option })),
    contextWindowDefault: row.contextWindowDefault,
    contextTokens: row.contextTokens,
    maxTokens: row.maxTokens ?? DEFAULT_CONTEXT_TOKENS,
    thinkingLevelMap: row.thinkingLevelMap ? { ...row.thinkingLevelMap } : undefined,
    headers: row.headers,
    compat: row.compat,
    mediaInput: row.mediaInput,
  };
}
