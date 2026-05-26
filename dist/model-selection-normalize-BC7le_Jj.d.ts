import { t as PluginManifestRecord } from "./manifest-registry-CMekBFSM.js";

//#region src/agents/model-selection-normalize.d.ts
type ModelRef = {
  provider: string;
  model: string;
};
type ModelManifestNormalizationContext = {
  manifestPlugins?: readonly Pick<PluginManifestRecord, "modelIdNormalization">[];
};
declare function modelKey(provider: string, model: string): string;
declare function legacyModelKey(provider: string, model: string): string | null;
type ModelRefNormalizeOptions = ModelManifestNormalizationContext & {
  allowManifestNormalization?: boolean;
  allowPluginNormalization?: boolean;
};
declare function normalizeModelRef(provider: string, model: string, options?: ModelRefNormalizeOptions): ModelRef;
type ParseModelRefOptions = ModelRefNormalizeOptions;
declare function parseModelRef(raw: string, defaultProvider: string, options?: ParseModelRefOptions): ModelRef | null;
//#endregion
export { normalizeModelRef as a, modelKey as i, ModelRef as n, parseModelRef as o, legacyModelKey as r, ModelManifestNormalizationContext as t };