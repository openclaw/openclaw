/**
 * Chromium rejects a per-request Fetch command with this error when the paused
 * request already ended (the page cancelled it, or its frame went away). The
 * lookup fails before any mutation, and the request can no longer load.
 */
export function isRetiredFetchInterceptionError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("Invalid InterceptionId");
}
