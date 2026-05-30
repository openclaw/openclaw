import { loadWorkspaceBootstrapFiles, type WorkspaceBootstrapFile } from "./workspace.js";

type BootstrapSnapshot = {
  workspaceDir: string;
  files: WorkspaceBootstrapFile[];
};

// Cap the number of cached session bootstrap snapshots. Each entry holds the
// workspace bootstrap file contents for one session key; without a cap, long-running
// gateways accumulate one entry per distinct session key, which produces unbounded
// memory growth over time.
const BOOTSTRAP_CACHE_MAX_SIZE = 64;

const cache = new Map<string, BootstrapSnapshot>();

function bootstrapFilesEqual(
  previous: WorkspaceBootstrapFile[],
  next: WorkspaceBootstrapFile[],
): boolean {
  if (previous.length !== next.length) {
    return false;
  }

  return previous.every((file, index) => {
    const updated = next[index];
    return (
      updated !== undefined &&
      file.name === updated.name &&
      file.path === updated.path &&
      file.content === updated.content &&
      file.missing === updated.missing
    );
  });
}

function setCacheEntry(sessionKey: string, snapshot: BootstrapSnapshot): void {
  // Delete then re-insert to refresh the insertion-order position (LRU-like).
  cache.delete(sessionKey);
  // Evict the oldest entry when the cache is at capacity.
  if (cache.size >= BOOTSTRAP_CACHE_MAX_SIZE) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) {
      cache.delete(oldestKey);
    }
  }
  cache.set(sessionKey, snapshot);
}

export async function getOrLoadBootstrapFiles(params: {
  workspaceDir: string;
  sessionKey: string;
}): Promise<WorkspaceBootstrapFile[]> {
  const existing = cache.get(params.sessionKey);
  // Refresh per turn so long-lived sessions pick up edits; loadWorkspaceBootstrapFiles
  // handles unchanged file content through its guarded inode/mtime cache.
  const files = await loadWorkspaceBootstrapFiles(params.workspaceDir);
  if (
    existing &&
    existing.workspaceDir === params.workspaceDir &&
    bootstrapFilesEqual(existing.files, files)
  ) {
    // Refresh insertion-order position on access so active sessions stay hot.
    setCacheEntry(params.sessionKey, existing);
    return existing.files;
  }

  setCacheEntry(params.sessionKey, { workspaceDir: params.workspaceDir, files });
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

/** Exposed for testing only. */
export function getBootstrapCacheSizeForTest(): number {
  return cache.size;
}
