import { t as ModelCatalogEntry } from "../../model-catalog.types-CRpxx7uE.js";
import { qn as ProviderRuntimeModel } from "../../types-lCXG2pW_.js";
//#region extensions/opencode-go/provider-catalog.d.ts
declare function listOpencodeGoSupplementalModelCatalogEntries(): ModelCatalogEntry[];
declare function resolveOpencodeGoSupplementalModel(modelId: string): ProviderRuntimeModel | undefined;
declare function normalizeOpencodeGoBaseUrl(params: {
  api?: string | null;
  baseUrl?: string;
}): string | undefined;
//#endregion
export { listOpencodeGoSupplementalModelCatalogEntries, normalizeOpencodeGoBaseUrl, resolveOpencodeGoSupplementalModel };