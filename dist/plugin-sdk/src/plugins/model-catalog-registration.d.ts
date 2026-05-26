import { type MediaGenerationCatalogKind, type MediaGenerationCatalogProvider } from "../media-generation/catalog.js";
import type { PluginDiagnostic } from "./manifest-types.js";
import type { PluginRecord, PluginRegistry } from "./registry-types.js";
import type { ProviderPlugin, UnifiedModelCatalogProviderPlugin } from "./types.js";
export declare function createModelCatalogRegistrationHandlers(params: {
    registry: PluginRegistry;
    pushDiagnostic: (diagnostic: PluginDiagnostic) => void;
}): {
    registerModelCatalogProvider: (record: PluginRecord, provider: UnifiedModelCatalogProviderPlugin) => void;
    registerSynthesizedTextModelCatalogProvider: (registration: {
        record: PluginRecord;
        provider: ProviderPlugin;
    }) => void;
    registerSynthesizedMediaModelCatalogProvider: <TCapabilities>(registration: {
        record: PluginRecord;
        kind: MediaGenerationCatalogKind;
        provider: MediaGenerationCatalogProvider<TCapabilities>;
    }) => void;
};
