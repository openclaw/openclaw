import { statSync } from "node:fs";
import { loadWorkspaceBootstrapFiles, type WorkspaceBootstrapFile } from "./workspace.js";

interface CachedSnapshot {
  files: WorkspaceBootstrapFile[];
  mtimes: Map<string, number>; // path → mtimeMs
}

function isStale(snap: CachedSnapshot): boolean {
  for (const [filePath, cachedMtime] of snap.mtimes) {
    try {
      if (statSync(filePath).mtimeMs !== cachedMtime) {
        return true;
      }
    } catch {
      return true;
    }
  }
  return false;
}

function collectMtimes(files: WorkspaceBootstrapFile[]): Map<string, number> {
  const mtimes = new Map<string, number>();
  for (const file of files) {
    try {
      mtimes.set(file.path, statSync(file.path).mtimeMs);
    } catch {
      // File may have been removed; skip it
    }
  }
  return mtimes;
}

const cache = new Map<string, CachedSnapshot>();

export async function getOrLoadBootstrapFiles(params: {
  workspaceDir: string;
  sessionKey: string;
}): Promise<WorkspaceBootstrapFile[]> {
  const existing = cache.get(params.sessionKey);
  if (existing && !isStale(existing)) {
    return existing.files;
  }

  const files = await loadWorkspaceBootstrapFiles(params.workspaceDir);
  cache.set(params.sessionKey, { files, mtimes: collectMtimes(files) });
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
