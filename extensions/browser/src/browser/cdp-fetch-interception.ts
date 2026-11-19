/**
 * Chromium rejects a per-request Fetch command with this error when the paused
 * request already ended (the page cancelled it, or its frame went away). The
 * lookup fails before any mutation, and the request can no longer load.
 */
export function isRetiredFetchInterceptionError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("Invalid InterceptionId");
}

type FetchSettleTarget = {
  send(
    method: "Fetch.continueRequest" | "Fetch.failRequest",
    params: { requestId: string; errorReason?: "Failed" | "Aborted" | "BlockedByClient" },
  ): Promise<unknown>;
};

/**
 * Resolve or fail one paused request. A request the page already cancelled has
 * nothing left to admit or deny, so its retired id is not a navigation failure.
 */
export async function settleInterception(
  target: FetchSettleTarget,
  method: "Fetch.continueRequest" | "Fetch.failRequest",
  params: { requestId: string; errorReason?: "Failed" | "Aborted" | "BlockedByClient" },
): Promise<void> {
  try {
    await target.send(method, params);
  } catch (error) {
    if (!isRetiredFetchInterceptionError(error)) {
      throw error;
    }
  }
}
