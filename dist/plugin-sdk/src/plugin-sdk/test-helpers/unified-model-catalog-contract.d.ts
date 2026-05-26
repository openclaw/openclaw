import type { OpenClawPluginApi, UnifiedModelCatalogEntry, UnifiedModelCatalogKind, UnifiedModelCatalogProviderPlugin } from "../plugin-entry.js";
type RegistrablePlugin = {
    register(api: OpenClawPluginApi): void;
};
export declare function expectUnifiedModelCatalogEntries(rows: readonly UnifiedModelCatalogEntry[] | null | undefined, params: {
    provider: string;
    kind: UnifiedModelCatalogKind;
}): asserts rows is readonly UnifiedModelCatalogEntry[];
export declare function expectUnifiedModelCatalogProviderRegistration(params: {
    plugin: RegistrablePlugin;
    pluginId?: string;
    pluginName?: string;
    provider: string;
    kind: UnifiedModelCatalogKind;
}): UnifiedModelCatalogProviderPlugin;
export {};
