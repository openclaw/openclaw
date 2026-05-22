export declare function setCurrentPluginMetadataSnapshotState(snapshot: unknown, configFingerprint: string | undefined): void;
export declare function clearCurrentPluginMetadataSnapshotState(): void;
export declare function getCurrentPluginMetadataSnapshotState(): {
    snapshot: unknown;
    configFingerprint: string | undefined;
};
