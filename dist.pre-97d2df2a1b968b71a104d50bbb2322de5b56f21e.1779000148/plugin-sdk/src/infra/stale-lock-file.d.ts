export type LockFileOwnerPayload = {
    pid?: number;
    createdAt?: string;
};
export declare function readLockFileOwnerPayload(payload: Record<string, unknown> | null): LockFileOwnerPayload | null;
export declare function shouldRemoveDeadOwnerOrExpiredLock(params: {
    payload: Record<string, unknown> | null;
    staleMs: number;
    nowMs?: number;
    isPidDefinitelyDead?: (pid: number) => boolean;
}): boolean;
