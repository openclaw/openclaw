import { t as ModelCatalogEntry } from "../../model-catalog.types-LYni1Yjz.js";
import { Qn as ProviderRuntimeModel } from "../../types-Vx7Jq4_-2.js";
//#region extensions/opencode-go/provider-catalog.d.ts
declare function listOpencodeGoSupplementalModelCatalogEntries(): ModelCatalogEntry[];
declare function resolveOpencodeGoSupplementalModel(modelId: string): ProviderRuntimeModel | undefined;
declare function isOpencodeGoKimiNoReasoningModelId(modelId: unknown): boolean;
declare function normalizeOpencodeGoResolvedModel(model: ProviderRuntimeModel): ProviderRuntimeModel | undefined;
declare function normalizeOpencodeGoBaseUrl(params: {
  api?: string | null;
  baseUrl?: string;
}): string | undefined;
//#endregion
export { isOpencodeGoKimiNoReasoningModelId, listOpencodeGoSupplementalModelCatalogEntries, normalizeOpencodeGoBaseUrl, normalizeOpencodeGoResolvedModel, resolveOpencodeGoSupplementalModel };