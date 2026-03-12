export { createAsyncLock, readJsonFile, writeJsonAtomic } from "./json-files.js";
export declare function resolvePairingPaths(baseDir: string | undefined, subdir: string): {
    dir: string;
    pendingPath: string;
    pairedPath: string;
};
export declare function pruneExpiredPending<T extends {
    ts: number;
}>(pendingById: Record<string, T>, nowMs: number, ttlMs: number): void;
export type PendingPairingRequestResult<TPending> = {
    status: "pending";
    request: TPending;
    created: boolean;
};
export declare function upsertPendingPairingRequest<TPending extends {
    requestId: string;
}>(params: {
    pendingById: Record<string, TPending>;
    isExisting: (pending: TPending) => boolean;
    createRequest: (isRepair: boolean) => TPending;
    isRepair: boolean;
    persist: () => Promise<void>;
}): Promise<PendingPairingRequestResult<TPending>>;
