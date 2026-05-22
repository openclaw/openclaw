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
};
export type PluginManifestCommandAliasRegistry = {
    plugins: readonly {
        id: string;
        commandAliases?: readonly PluginManifestCommandAlias[];
    }[];
};
export declare function normalizeManifestCommandAliases(value: unknown): PluginManifestCommandAlias[] | undefined;
export declare function resolveManifestCommandAliasOwnerInRegistry(params: {
    command: string | undefined;
    registry: PluginManifestCommandAliasRegistry;
}): PluginManifestCommandAliasRecord | undefined;
