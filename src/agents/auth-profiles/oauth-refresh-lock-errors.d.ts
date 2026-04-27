export declare function isGlobalRefreshLockTimeoutError(error: unknown, lockPath: string): boolean;
export declare function buildRefreshContentionError(params: {
    provider: string;
    profileId: string;
    cause: unknown;
}): Error & {
    code: "refresh_contention";
    cause: unknown;
};
