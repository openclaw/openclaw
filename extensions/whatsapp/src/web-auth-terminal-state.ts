// WhatsApp plugin module tracks terminal auth facts observed by the live runtime.

const loggedOutWebAuthAccounts = new Set<string>();

// The monitor preserves auth files on terminal closes, so explicit relink flows
// need this process-local fact to distinguish stale logged-out creds from a
// healthy linked session without adding another steady-state storage path.
export function markWebAuthLoggedOut(accountId: string): void {
  loggedOutWebAuthAccounts.add(accountId);
}

export function clearWebAuthLoggedOut(accountId: string): void {
  loggedOutWebAuthAccounts.delete(accountId);
}

export function isWebAuthLoggedOut(accountId: string): boolean {
  return loggedOutWebAuthAccounts.has(accountId);
}
