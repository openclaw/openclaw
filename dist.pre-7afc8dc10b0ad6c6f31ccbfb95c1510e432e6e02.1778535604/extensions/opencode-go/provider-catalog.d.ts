import { t as ModelCatalogEntry } from "../../model-catalog.types-BN5LqwSr.js";
import { zn as ProviderRuntimeModel } from "../../types-DaukV8xd.js";
//#region extensions/opencode-go/provider-catalog.d.ts
declare function listOpencodeGoSupplementalModelCatalogEntries(): ModelCatalogEntry[];
declare function resolveOpencodeGoSupplementalModel(modelId: string): ProviderRuntimeModel | undefined;
declare function normalizeOpencodeGoBaseUrl(params: {
  api?: string | null;
  baseUrl?: string;
}): string | undefined;
//#endregion
export { listOpencodeGoSupplementalModelCatalogEntries, normalizeOpencodeGoBaseUrl, resolveOpencodeGoSupplementalModel };