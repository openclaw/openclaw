export declare const pluginSdkEntrypoints: string[];
export declare const pluginSdkSubpaths: string[];
export declare const reservedBundledPluginSdkEntrypoints: readonly [];
export declare const supportedBundledFacadeSdkEntrypoints: readonly ["discord", "lmstudio", "lmstudio-runtime", "memory-core-engine-runtime", "qa-runner-runtime", "telegram-account", "tts-runtime", "zalouser"];
export declare const publicPluginOwnedSdkEntrypoints: readonly ["browser-config", "image-generation-core", "memory-core-host-engine-embeddings", "memory-core-host-engine-foundation", "memory-core-host-engine-qmd", "memory-core-host-engine-storage", "memory-core-host-events", "memory-core-host-multimodal", "memory-core-host-query", "memory-core-host-runtime-cli", "memory-core-host-runtime-core", "memory-core-host-runtime-files", "memory-core-host-secret", "memory-core-host-status", "memory-host-core", "memory-host-events", "memory-host-files", "memory-host-markdown", "memory-host-search", "memory-host-status", "speech-core", "telegram-command-config", "video-generation-core"];
/** Map every SDK entrypoint name to its source file path inside the repo. */
export declare function buildPluginSdkEntrySources(entries?: readonly string[]): {
    [k: string]: string;
};
/** List the public package specifiers that should resolve to plugin SDK entrypoints. */
export declare function buildPluginSdkSpecifiers(): string[];
/** Build the package.json exports map for all plugin SDK subpaths. */
export declare function buildPluginSdkPackageExports(): {
    [k: string]: {
        types: string;
        default: string;
    };
};
/** List the dist artifacts expected for every generated plugin SDK entrypoint. */
export declare function listPluginSdkDistArtifacts(): string[];
