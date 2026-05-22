type PluginManifestMetadataRecord = {
    pluginDir: string;
    manifest: Record<string, unknown>;
    origin?: string;
};
/**
 * Internal helper: clears the parsed-JSON cache. Exposed for tests; not part of
 * the public module API.
 */
export declare function clearParsedJsonCacheForTesting(): void;
export declare function listOpenClawPluginManifestMetadata(env?: NodeJS.ProcessEnv): PluginManifestMetadataRecord[];
export {};
