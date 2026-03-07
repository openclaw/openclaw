import { loadWorkspaceBootstrapFiles, type WorkspaceBootstrapFile } from "./workspace.js";

const cache = new Map<string, WorkspaceBootstrapFile[]>();

/**
 * Build cache key from sessionKey and optional sessionId.
 * Including sessionId ensures fresh bootstrap files on daily reset (new sessionId, same sessionKey).
 */
function buildCacheKey(sessionKey: string, sessionId?: string): string {
  return sessionId ? `${sessionKey}:${sessionId}` : sessionKey;
}

/**
 * Clear stale cache entries for a sessionKey (except the current sessionId).
 * This prevents unbounded cache growth over time.
 */
function clearStaleEntries(sessionKey: string, currentSessionId?: string): void {
  if (!currentSessionId) return;
  const prefix = `${sessionKey}:`;
  // Collect keys first, then delete to avoid iterator issues
  const keysToDelete = [...cache.keys()].filter(
    (key) => key.startsWith(prefix) && !key.endsWith(`:${currentSessionId}`)
  );
  for (const key of keysToDelete) {
    cache.delete(key);
  }
}

export async function getOrLoadBootstrapFiles(params: {
  workspaceDir: string;
  sessionKey: string;
  sessionId?: string;
}): Promise<WorkspaceBootstrapFile[]> {
  const cacheKey = buildCacheKey(params.sessionKey, params.sessionId);
  const existing = cache.get(cacheKey);
  if (existing) {
    return existing;
  }

  // Clear stale entries for this sessionKey before adding new one
  clearStaleEntries(params.sessionKey, params.sessionId);

  const files = await loadWorkspaceBootstrapFiles(params.workspaceDir);
  cache.set(cacheKey, files);
  return files;
}

export function clearBootstrapSnapshot(sessionKey: string, sessionId?: string): void {
  // Clear specific key if sessionId provided, otherwise clear all keys matching sessionKey prefix
  if (sessionId) {
    cache.delete(buildCacheKey(sessionKey, sessionId));
  } else {
    // Clear all cached entries for this sessionKey (handles daily reset - new sessionId)
    // Collect keys first, then delete to avoid iterator issues
    const keysToDelete = [...cache.keys()].filter(
      (key) => key === sessionKey || key.startsWith(`${sessionKey}:`)
    );
    for (const key of keysToDelete) {
      cache.delete(key);
    }
  }
}

export function clearAllBootstrapSnapshots(): void {
  cache.clear();
}
