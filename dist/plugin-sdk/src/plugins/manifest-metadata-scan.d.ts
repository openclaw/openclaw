type PluginManifestMetadataRecord = {
    pluginDir: string;
    manifest: Record<string, unknown>;
    origin?: string;
};
export declare function listOpenClawPluginManifestMetadata(env?: NodeJS.ProcessEnv): PluginManifestMetadataRecord[];
export {};
