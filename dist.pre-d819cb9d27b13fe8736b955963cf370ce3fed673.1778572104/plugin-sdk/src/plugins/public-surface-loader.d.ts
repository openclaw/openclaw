export declare function loadBundledPluginPublicArtifactModuleSync<T extends object>(params: {
    dirName: string;
    artifactBasename: string;
}): T;
export declare function resolveBundledPluginPublicArtifactPath(params: {
    dirName: string;
    artifactBasename: string;
}): string | null;
export declare function resetBundledPluginPublicArtifactLoaderForTest(): void;
