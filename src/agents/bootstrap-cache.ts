import path from "node:path";
import { loadWorkspaceBootstrapFiles, type WorkspaceBootstrapFile } from "./workspace.js";

const cache = new Map<string, WorkspaceBootstrapFile[]>();

/** Normalize a path for dedup comparison: consistent separators + lowercase for Windows. */
function normalizeForDedup(p: string): string {
  return path.normalize(p).toLowerCase();
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

  // Deduplicate by normalized path (case-insensitive), keeping first occurrence
  const seen = new Set<string>();
  const deduped = files.filter((file) => {
    const key = normalizeForDedup(file.path);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });

  cache.set(params.sessionKey, deduped);
  return deduped;
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
