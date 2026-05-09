import { OPENCLAW_STATE_LOCK_TIMEOUT_ERROR_CODE } from "../../state/openclaw-state-lock.js";

export function isGlobalRefreshLockTimeoutError(
  error: unknown,
  scope: string,
  key: string,
): boolean {
  const candidate =
    typeof error === "object" && error !== null
      ? (error as { code?: unknown; scope?: unknown; key?: unknown })
      : undefined;
  return (
    candidate?.code === OPENCLAW_STATE_LOCK_TIMEOUT_ERROR_CODE &&
    candidate.scope === scope &&
    candidate.key === key
  );
}

export function buildRefreshContentionError(params: {
  provider: string;
  profileId: string;
  cause: unknown;
}): Error & { code: "refresh_contention"; cause: unknown } {
  return Object.assign(
    new Error(
      `OAuth refresh failed (refresh_contention): another process is already refreshing ${params.provider} for ${params.profileId}. Please wait for the in-flight refresh to finish and retry.`,
      { cause: params.cause },
    ),
    {
      code: "refresh_contention" as const,
      cause: params.cause,
    },
  );
}
