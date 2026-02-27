import { statSync } from "node:fs";
import { loadWorkspaceBootstrapFiles, type WorkspaceBootstrapFile } from "./workspace.js";

interface CachedSnapshot {
  files: WorkspaceBootstrapFile[];
  /** file path → mtimeMs at the time of caching */
  mtimes: Map<string, number>;
}

const cache = new Map<string, CachedSnapshot>();

/** Capture mtimeMs for each non-missing bootstrap file. */
function snapshotMtimes(files: WorkspaceBootstrapFile[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const f of files) {
    if (!f.missing) {
      try {
        m.set(f.path, statSync(f.path).mtimeMs);
      } catch {
        // file may have been deleted since load — skip
      }
    }
  }
  return m;
}

/** True when any cached file's mtime has changed on disk. */
function isStale(snap: CachedSnapshot): boolean {
  for (const [filePath, cachedMtime] of snap.mtimes) {
    try {
      if (statSync(filePath).mtimeMs !== cachedMtime) {
        return true;
      }
    } catch {
      // file deleted → stale
      return true;
    }
  }
  return false;
}

export async function getOrLoadBootstrapFiles(params: {
  workspaceDir: string;
  sessionKey: string;
}): Promise<WorkspaceBootstrapFile[]> {
  const snap = cache.get(params.sessionKey);
  if (snap && !isStale(snap)) {
    return snap.files;
  }

  const files = await loadWorkspaceBootstrapFiles(params.workspaceDir);
  cache.set(params.sessionKey, { files, mtimes: snapshotMtimes(files) });
  return files;
}

export function clearBootstrapSnapshot(sessionKey: string): void {
  cache.delete(sessionKey);
}

export function clearAllBootstrapSnapshots(): void {
  cache.clear();
}
