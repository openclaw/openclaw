import { loadWorkspaceBootstrapFiles, type WorkspaceBootstrapFile } from "./workspace.js";

/**
 * TTL for cached bootstrap files in milliseconds.
 * Set to 5 minutes to balance performance with responsiveness to file changes.
 * The underlying workspace.ts has mtime-based caching, so disk reads are
 * only triggered when files actually change.
 */
const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  files: WorkspaceBootstrapFile[];
  timestamp: number;
}

const cache = new Map<string, CacheEntry>();

export async function getOrLoadBootstrapFiles(params: {
  workspaceDir: string;
  sessionKey: string;
}): Promise<WorkspaceBootstrapFile[]> {
  const existing = cache.get(params.sessionKey);
  const now = Date.now();

  // Return cached result if within TTL
  if (existing && now - existing.timestamp < CACHE_TTL_MS) {
    return existing.files;
  }

  const files = await loadWorkspaceBootstrapFiles(params.workspaceDir);
  cache.set(params.sessionKey, { files, timestamp: now });
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

/**
 * Get the configured cache TTL in milliseconds.
 * Exposed for testing purposes.
 */
export function getCacheTtlMs(): number {
  return CACHE_TTL_MS;
}
