import { loadWorkspaceBootstrapFiles, type WorkspaceBootstrapFile } from "./workspace.js";

const CACHE_MAX_SIZE = 500;
const CACHE_TTL_MS = 30 * 60 * 1000;

type CacheEntry = {
  files: WorkspaceBootstrapFile[];
  loadedAt: number;
};

const cache = new Map<string, CacheEntry>();

function evictExpiredEntries(): void {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.loadedAt > CACHE_TTL_MS) {
      cache.delete(key);
    }
  }
}

function evictOldestEntry(): void {
  const oldest = cache.keys().next().value;
  if (oldest !== undefined) {
    cache.delete(oldest);
  }
}

export async function getOrLoadBootstrapFiles(params: {
  workspaceDir: string;
  sessionKey: string;
}): Promise<WorkspaceBootstrapFile[]> {
  const now = Date.now();
  const existing = cache.get(params.sessionKey);
  if (existing && now - existing.loadedAt <= CACHE_TTL_MS) {
    return existing.files;
  }

  const files = await loadWorkspaceBootstrapFiles(params.workspaceDir);

  if (cache.size >= CACHE_MAX_SIZE) {
    evictExpiredEntries();
    if (cache.size >= CACHE_MAX_SIZE) {
      evictOldestEntry();
    }
  }

  cache.set(params.sessionKey, { files, loadedAt: now });
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
