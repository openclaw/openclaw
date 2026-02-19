import { loadWorkspaceBootstrapFiles, type WorkspaceBootstrapFile } from "./workspace.js";

const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

type BootstrapCacheEntry = {
  files: WorkspaceBootstrapFile[];
  workspaceDir: string;
  createdAt: number;
};

const cache = new Map<string, BootstrapCacheEntry>();

function resolveBootstrapCacheKey(params: {
  sessionKey?: string;
  sessionId?: string;
}): string | undefined {
  return params.sessionKey ?? params.sessionId;
}

function sweepStaleEntries(): void {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.createdAt > TTL_MS) {
      cache.delete(key);
    }
  }
}

export async function getOrLoadBootstrapFiles(params: {
  workspaceDir: string;
  sessionKey?: string;
  sessionId?: string;
}): Promise<WorkspaceBootstrapFile[]> {
  const cacheKey = resolveBootstrapCacheKey(params);

  if (cacheKey) {
    sweepStaleEntries();
    const existing = cache.get(cacheKey);
    if (existing) {
      // Bypass cache if workspaceDir changed (shouldn't happen in practice)
      if (existing.workspaceDir === params.workspaceDir) {
        return existing.files;
      }
      cache.delete(cacheKey);
    }
  }

  const files = await loadWorkspaceBootstrapFiles(params.workspaceDir);

  if (cacheKey) {
    cache.set(cacheKey, {
      files,
      workspaceDir: params.workspaceDir,
      createdAt: Date.now(),
    });
  }

  return files;
}

export function clearBootstrapSnapshot(cacheKey: string): void {
  cache.delete(cacheKey);
}

export function clearAllBootstrapSnapshots(): void {
  cache.clear();
}
