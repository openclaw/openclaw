import { MODEL_APIS } from "../config/types.models.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";

function isCatalogModelApi(
  value: string | undefined,
): value is NonNullable<ModelCatalogEntry["api"]> {
  return value !== undefined && MODEL_APIS.some((api) => api === value);
}

/** Shared metadata projection; keep transport headers and authoring fields out of catalog entries. */
export function modelCatalogRowToEntry(
  row: Omit<ModelCatalogEntry, "api"> & { api?: string },
): ModelCatalogEntry {
  const contextWindow = row.contextWindow ?? row.contextTokens;
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    ...(isCatalogModelApi(row.api) ? { api: row.api } : {}),
    ...(row.baseUrl ? { baseUrl: row.baseUrl } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(row.contextWindows
      ? { contextWindows: row.contextWindows.map((option) => ({ ...option })) }
      : {}),
    ...(row.contextWindowDefault ? { contextWindowDefault: row.contextWindowDefault } : {}),
    ...(row.contextTokens !== undefined ? { contextTokens: row.contextTokens } : {}),
    reasoning: row.reasoning,
    ...(row.thinkingLevelMap ? { thinkingLevelMap: { ...row.thinkingLevelMap } } : {}),
    ...(row.input ? { input: [...row.input] } : {}),
    ...(row.params ? { params: { ...row.params } } : {}),
    ...(row.compat ? { compat: row.compat } : {}),
    ...(row.mediaInput ? { mediaInput: row.mediaInput } : {}),
    status: row.status,
    ...(row.statusReason ? { statusReason: row.statusReason } : {}),
    ...(row.replaces ? { replaces: [...row.replaces] } : {}),
    ...(row.replacedBy ? { replacedBy: row.replacedBy } : {}),
  };
}
