import { findErrorProperty, isFailoverError, type FailoverError } from "./error.js";
import type { FailoverReason } from "./signal.js";

/** A typed aggregate owns its final candidate's facts, including absent ownership. */
export function findHostManagedAuthFailure(error: unknown): FailoverError | undefined {
  const failure = findErrorProperty(error, (candidate) =>
    isFailoverError(candidate) ? candidate : undefined,
  );
  return failure?.authOwner === "host" ? failure : undefined;
}

export const HOST_MANAGED_AUTH_ERROR_USER_TEXT =
  "Authentication failed on the app-server host. The host manages credentials automatically. " +
  "Retry in a moment; if the failure persists, ask the host operator to check authentication.";

/** Recovery follows the owner of the failed credential, not the provider name. */
export function renderHostManagedAuthFailureCopy(params: {
  authOwner?: "host";
  reason?: FailoverReason | null;
  authFailure?: boolean;
}): string | undefined {
  return params.authOwner === "host" &&
    (params.authFailure === true ||
      params.reason === "auth" ||
      params.reason === "auth_permanent" ||
      params.reason === "session_expired")
    ? `⚠️ ${HOST_MANAGED_AUTH_ERROR_USER_TEXT}`
    : undefined;
}
