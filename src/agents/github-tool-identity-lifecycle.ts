import { notifyListeners, registerListener } from "../shared/listeners.js";
import type { inspectGitHubOAuthRecord } from "./github-oauth-records.js";

type ProfileChange = { profileDir: string; kind: "updated" | "removed" };
const profileListeners = new Set<(change: ProfileChange) => void>();

/** Execution copies follow completed writes by the profile owner. */
export function onManagedGitHubProfileChanged(
  listener: (change: ProfileChange) => void,
): () => void {
  return registerListener(profileListeners, listener);
}

export function notifyManagedGitHubProfileChanged(change: ProfileChange): void {
  notifyListeners(profileListeners, change);
}

/** Never attach a replacement record's expiry to a token read before its rotation. */
export function resolveGitHubPublicationAccessExpiry(
  before: Awaited<ReturnType<typeof inspectGitHubOAuthRecord>> | undefined,
  after: Awaited<ReturnType<typeof inspectGitHubOAuthRecord>> | undefined,
  accountId: number,
): number | undefined {
  return before?.state === "valid" &&
    after?.state === "valid" &&
    !before.record.pendingRefresh &&
    !before.record.pendingInitial &&
    !after.record.pendingRefresh &&
    !after.record.pendingInitial &&
    before.record.refreshToken === after.record.refreshToken &&
    after.record.accountId === accountId
    ? after.record.accessExpiresAtMs
    : undefined;
}
