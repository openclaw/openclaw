import { FILE_LOCK_TIMEOUT_ERROR_CODE } from "../../infra/file-lock.js";
export function isGlobalRefreshLockTimeoutError(error, lockPath) {
    const candidate = typeof error === "object" && error !== null
        ? error
        : undefined;
    return (candidate?.code === FILE_LOCK_TIMEOUT_ERROR_CODE && candidate.lockPath === `${lockPath}.lock`);
}
export function buildRefreshContentionError(params) {
    return Object.assign(new Error(`OAuth refresh failed (refresh_contention): another process is already refreshing ${params.provider} for ${params.profileId}. Please wait for the in-flight refresh to finish and retry.`, { cause: params.cause }), {
        code: "refresh_contention",
        cause: params.cause,
    });
}
