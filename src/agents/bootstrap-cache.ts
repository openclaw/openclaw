import { loadWorkspaceBootstrapFiles, type WorkspaceBootstrapFile } from "./workspace.js";

const MAX_CACHE_ENTRIES = 64;

const cache = new Map<string, WorkspaceBootstrapFile[]>();

function evictOldestIfNeeded(): void {
  if (cache.size < MAX_CACHE_ENTRIES) {
    return;
  }
  // Map iterates in insertion order; delete the oldest entry.
  const oldest = cache.keys().next().value;
  if (oldest !== undefined) {
    cache.delete(oldest);
  }
}

export async function getOrLoadBootstrapFiles(params: {
  workspaceDir: string;
  sessionKey: string;
}): Promise<WorkspaceBootstrapFile[]> {
  const existing = cache.get(params.sessionKey);
  if (existing) {
    return existing;
  }

  const files = await loadWorkspaceBootstrapFiles(params.workspaceDir);
  evictOldestIfNeeded();
  cache.set(params.sessionKey, files);
  return files;
}

export function clearBootstrapSnapshot(sessionKey: string): void {
  cache.delete(sessionKey);
}

export function clearBootstrapSnapshotOnSessionRollover(params: {
  sessionKey?: string;
  previousSessionId?: string;
}): void {
  if (!params.sessionKey || !params.previousSessionId) {
    return;
  }

  clearBootstrapSnapshot(params.sessionKey);
}

export function clearAllBootstrapSnapshots(): void {
  cache.clear();
}
