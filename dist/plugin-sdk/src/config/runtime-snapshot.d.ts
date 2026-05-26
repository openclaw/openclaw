import type { OpenClawConfig } from "./types.js";
export type RuntimeConfigSnapshotRefreshParams = {
    sourceConfig: OpenClawConfig;
};
export type ConfigWriteAfterWrite = {
    mode: "auto";
} | {
    mode: "restart";
    reason: string;
} | {
    mode: "none";
    reason: string;
};
export type ConfigWriteFollowUp = {
    mode: "auto";
    requiresRestart: false;
} | {
    mode: "none";
    reason: string;
    requiresRestart: false;
} | {
    mode: "restart";
    reason: string;
    requiresRestart: true;
};
export declare function resolveConfigWriteAfterWrite(afterWrite?: ConfigWriteAfterWrite): ConfigWriteAfterWrite;
export declare function resolveConfigWriteFollowUp(afterWrite?: ConfigWriteAfterWrite): ConfigWriteFollowUp;
export type RuntimeConfigSnapshotRefreshHandler = {
    refresh: (params: RuntimeConfigSnapshotRefreshParams) => boolean | Promise<boolean>;
    clearOnRefreshFailure?: () => void;
};
export type RuntimeConfigWriteNotification = {
    configPath: string;
    sourceConfig: OpenClawConfig;
    runtimeConfig: OpenClawConfig;
    persistedHash: string;
    revision: number;
    fingerprint: string;
    sourceFingerprint: string | null;
    writtenAtMs: number;
    afterWrite?: ConfigWriteAfterWrite;
};
export type RuntimeConfigSnapshotMetadata = {
    revision: number;
    fingerprint: string;
    sourceFingerprint: string | null;
    updatedAtMs: number;
};
export declare function hashRuntimeConfigValue(value: OpenClawConfig): string;
export declare function setRuntimeConfigSnapshot(config: OpenClawConfig, sourceConfig?: OpenClawConfig): void;
export declare function resetConfigRuntimeState(): void;
export declare function clearRuntimeConfigSnapshot(): void;
export declare function getRuntimeConfigSnapshot(): OpenClawConfig | null;
export declare function getRuntimeConfigSourceSnapshot(): OpenClawConfig | null;
export declare function getRuntimeConfigSnapshotMetadata(): RuntimeConfigSnapshotMetadata | null;
export declare function resolveRuntimeConfigCacheKey(config: OpenClawConfig): string;
export declare function createRuntimeConfigWriteNotification(params: {
    configPath: string;
    sourceConfig: OpenClawConfig;
    runtimeConfig: OpenClawConfig;
    persistedHash: string;
    writtenAtMs?: number;
    afterWrite?: ConfigWriteAfterWrite;
}): RuntimeConfigWriteNotification;
export declare function selectApplicableRuntimeConfig(params: {
    inputConfig?: OpenClawConfig;
    runtimeConfig?: OpenClawConfig | null;
    runtimeSourceConfig?: OpenClawConfig | null;
}): OpenClawConfig | undefined;
export declare function setRuntimeConfigSnapshotRefreshHandler(refreshHandler: RuntimeConfigSnapshotRefreshHandler | null): void;
export declare function getRuntimeConfigSnapshotRefreshHandler(): RuntimeConfigSnapshotRefreshHandler | null;
export declare function registerRuntimeConfigWriteListener(listener: (event: RuntimeConfigWriteNotification) => void): () => void;
export declare function notifyRuntimeConfigWriteListeners(event: RuntimeConfigWriteNotification): void;
export declare function loadPinnedRuntimeConfig(loadFresh: () => OpenClawConfig): OpenClawConfig;
export declare function finalizeRuntimeSnapshotWrite(params: {
    nextSourceConfig: OpenClawConfig;
    hadRuntimeSnapshot: boolean;
    hadBothSnapshots: boolean;
    loadFreshConfig: () => OpenClawConfig;
    notifyCommittedWrite: () => void;
    createRefreshError: (detail: string, cause: unknown) => Error;
    formatRefreshError: (error: unknown) => string;
}): Promise<void>;
