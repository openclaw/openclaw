import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type {
  ControlUiSessionBranch,
  ControlUiSessionPullRequest,
} from "../control-ui-contract.js";

export function chatPullRequestId(pullRequest: ControlUiSessionPullRequest): string {
  return `${pullRequest.owner}/${pullRequest.repo}#${pullRequest.number}`.toLowerCase();
}

// Shares the per-session dismissal store with PR ids; `@` keeps the namespaces apart.
// GitHub owner/repo names are case-insensitive, but Git branch names are not.
export function chatBranchId(branch: ControlUiSessionBranch): string {
  return `${branch.owner}/${branch.repo}`.toLowerCase() + `@${branch.branch}`;
}

export function createGitHubPullRequestDismissals(getSafeLocalStorage: () => Storage | null) {
  const DISMISSED_STORAGE_KEY = "openclaw.chat.dismissedPullRequests";
  // Bounds localStorage growth: dismissals for the oldest sessions fall off
  // once this many sessions have dismissed chips.
  const DISMISSED_SESSION_LIMIT = 20;

  function readDismissedStore(storage: Storage): Record<string, string[]> {
    try {
      const parsed: unknown = JSON.parse(storage.getItem(DISMISSED_STORAGE_KEY) ?? "{}");
      if (!isRecord(parsed)) {
        return {};
      }
      const store: Record<string, string[]> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (Array.isArray(value)) {
          store[key] = value.filter((id): id is string => typeof id === "string");
        }
      }
      return store;
    } catch {
      return {};
    }
  }

  function listDismissedChatPullRequests(sessionKey: string): ReadonlySet<string> {
    const storage = getSafeLocalStorage();
    if (!storage || !sessionKey) {
      return new Set();
    }
    return new Set(readDismissedStore(storage)[sessionKey] ?? []);
  }

  function dismissChatPullRequest(sessionKey: string, id: string): ReadonlySet<string> {
    const storage = getSafeLocalStorage();
    if (!storage || !sessionKey) {
      return new Set([id]);
    }
    const store = readDismissedStore(storage);
    const ids = new Set(store[sessionKey] ?? []);
    ids.add(id);
    delete store[sessionKey];
    store[sessionKey] = [...ids];
    const staleSessions = Object.keys(store).slice(0, -DISMISSED_SESSION_LIMIT);
    for (const staleKey of staleSessions) {
      delete store[staleKey];
    }
    try {
      storage.setItem(DISMISSED_STORAGE_KEY, JSON.stringify(store));
    } catch {
      // Quota or privacy-mode failures only cost re-showing dismissed chips.
    }
    return ids;
  }

  return { listDismissedChatPullRequests, dismissChatPullRequest };
}
