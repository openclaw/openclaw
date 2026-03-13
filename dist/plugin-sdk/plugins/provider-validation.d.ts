import type { PluginDiagnostic, ProviderPlugin } from "./types.js";
export declare function normalizeRegisteredProvider(params: {
    pluginId: string;
    source: string;
    provider: ProviderPlugin;
    pushDiagnostic: (diag: PluginDiagnostic) => void;
}): ProviderPlugin | null;
