export declare function setCurrentPluginMetadataSnapshotState(snapshot: unknown, configFingerprint: string | undefined, compatiblePolicyHashes?: readonly string[], compatibleConfigFingerprints?: readonly string[]): void;
export declare function clearCurrentPluginMetadataSnapshotState(): void;
export declare function getCurrentPluginMetadataSnapshotState(): {
    snapshot: unknown;
    configFingerprint: string | undefined;
    compatiblePolicyHashes: readonly string[] | undefined;
    compatibleConfigFingerprints: readonly string[] | undefined;
};
