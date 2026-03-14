import { statSync } from "node:fs";
import { loadWorkspaceBootstrapFiles, type WorkspaceBootstrapFile } from "./workspace.js";

interface CachedSnapshot {
  files: WorkspaceBootstrapFile[];
  mtimes: Map<string, number | null>; // path → mtimeMs, null = missing at cache time
}

function isStale(snap: CachedSnapshot): boolean {
  for (const [filePath, cachedMtime] of snap.mtimes) {
    try {
      const currentMtime = statSync(filePath).mtimeMs;
      // File was missing before but now exists, or mtime changed
      if (cachedMtime === null || currentMtime !== cachedMtime) {
        return true;
      }
    } catch {
      // File is currently missing; stale only if it previously existed
      if (cachedMtime !== null) {
        return true;
      }
    }
  }
  return false;
}

function collectMtimes(files: WorkspaceBootstrapFile[]): Map<string, number | null> {
  const mtimes = new Map<string, number | null>();
  for (const file of files) {
    try {
      mtimes.set(file.path, statSync(file.path).mtimeMs);
    } catch {
      mtimes.set(file.path, null);
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
