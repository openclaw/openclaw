export type PluginManifestCommandAliasKind = "runtime-slash";
export type PluginManifestCommandAlias = {
    /** Command-like name users may put in plugin config by mistake. */
    name: string;
    /** Command family, used for targeted diagnostics. */
    kind?: PluginManifestCommandAliasKind;
    /** Optional root CLI command that handles related CLI operations. */
    cliCommand?: string;
};
export type PluginManifestCommandAliasRecord = PluginManifestCommandAlias & {
    pluginId: string;
    enabledByDefault?: boolean;
};
export type PluginManifestToolOwnerRecord = {
    toolName: string;
    pluginId: string;
    /**
     * "loaded" — the owning plugin passes control-plane availability filters and
     * the tool itself passes manifest-tool-availability checks (configSignals/
     * authSignals). The diagnostic can say the tool is available from this plugin.
     *
     * "manifest-only" — the manifest claims ownership but availability checks
     * either failed (plugin denied/disabled, missing required config) or were
     * not performed (pure registry lookup with no plugin metadata snapshot).
     * Emit a softer "may be provided by" message in that case so the diagnostic
     * does not over-assert about plugins that the runtime never registered.
     */
    availability?: "loaded" | "manifest-only";
};
export type PluginManifestCommandAliasRegistry = {
    plugins: readonly {
        id: string;
        enabledByDefault?: boolean;
        commandAliases?: readonly PluginManifestCommandAlias[];
        contracts?: {
            tools?: readonly string[];
        };
    }[];
};
export declare function normalizeManifestCommandAliases(value: unknown): PluginManifestCommandAlias[] | undefined;
export declare function resolveManifestToolOwnerInRegistry(params: {
    toolName: string | undefined;
    registry: PluginManifestCommandAliasRegistry;
}): PluginManifestToolOwnerRecord | undefined;
export declare function resolveManifestCommandAliasOwnerInRegistry(params: {
    command: string | undefined;
    registry: PluginManifestCommandAliasRegistry;
}): PluginManifestCommandAliasRecord | undefined;
