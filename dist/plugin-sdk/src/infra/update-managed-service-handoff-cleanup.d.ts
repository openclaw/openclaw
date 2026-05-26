export declare const MANAGED_SERVICE_UPDATE_HANDOFF_TEMP_PREFIX = "openclaw-update-run-handoff-";
export declare const MANAGED_SERVICE_UPDATE_HANDOFF_STALE_TTL_MS: number;
export declare function cleanupStaleManagedServiceUpdateHandoffs(params?: {
    tmpDir?: string;
    nowMs?: number;
    ttlMs?: number;
}): Promise<number>;
