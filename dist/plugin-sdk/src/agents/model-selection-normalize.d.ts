import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import { findNormalizedProviderKey, findNormalizedProviderValue, normalizeProviderId, normalizeProviderIdForAuth } from "./provider-id.js";
export type ModelRef = {
    provider: string;
    model: string;
};
export declare function modelKey(provider: string, model: string): string;
export declare function legacyModelKey(provider: string, model: string): string | null;
export { findNormalizedProviderKey, findNormalizedProviderValue, normalizeProviderId, normalizeProviderIdForAuth, };
type ModelRefNormalizeOptions = {
    allowManifestNormalization?: boolean;
    allowPluginNormalization?: boolean;
    manifestPlugins?: readonly Pick<PluginManifestRecord, "modelIdNormalization">[];
};
export declare function normalizeModelRef(provider: string, model: string, options?: ModelRefNormalizeOptions): ModelRef;
type ParseModelRefOptions = ModelRefNormalizeOptions;
export declare function parseModelRef(raw: string, defaultProvider: string, options?: ParseModelRefOptions): ModelRef | null;
