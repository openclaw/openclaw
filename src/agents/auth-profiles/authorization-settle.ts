import { sleepWithAbort } from "../../infra/backoff.js";
import { AuthProfileAuthorizationError } from "./authorization-contract.js";
import { OAUTH_REFRESH_CALL_TIMEOUT_MS } from "./constants.js";

const AUTHORIZATION_SETTLE_POLL_MS = 25;

/**
 * A peer's credential write (an OAuth refresh claim, then its result) leaves the shared
 * authorization observation unavailable until it settles. Wait for that publication within
 * the refresh-call bound instead of failing the caller; retirement and closure still throw.
 * Returns whether it had to wait, so callers can discard state read before the publication.
 */
export async function assertSettledAuthProfileAuthorization(
  assertCurrent: () => void,
  signal: AbortSignal,
): Promise<boolean> {
  const deadline = performance.now() + OAUTH_REFRESH_CALL_TIMEOUT_MS;
  for (let waited = false; ; waited = true) {
    try {
      assertCurrent();
      return waited;
    } catch (error) {
      if (
        !(error instanceof AuthProfileAuthorizationError) ||
        error.code !== "MCP_AUTHORIZATION_UNAVAILABLE" ||
        performance.now() >= deadline
      ) {
        throw error;
      }
    }
    await sleepWithAbort(AUTHORIZATION_SETTLE_POLL_MS, signal);
  }
}
