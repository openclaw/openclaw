import { statSync } from "node:fs";
import { loadWorkspaceBootstrapFiles, type WorkspaceBootstrapFile } from "./workspace.js";

interface CachedSnapshot {
  files: WorkspaceBootstrapFile[];
  /** file path → mtimeMs at the time of caching */
  mtimes: Map<string, number>;
}

const cache = new Map<string, CachedSnapshot>();

const MISSING_SENTINEL = -1;

/** Capture mtimeMs for each bootstrap file (missing files use a sentinel). */
function snapshotMtimes(files: WorkspaceBootstrapFile[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const f of files) {
    if (f.missing) {
      m.set(f.path, MISSING_SENTINEL);
    } else {
      try {
        m.set(f.path, statSync(f.path).mtimeMs);
      } catch {
        m.set(f.path, MISSING_SENTINEL);
      }
    }
  }
  return m;
}

/** True when any cached file's mtime has changed on disk. */
function isStale(snap: CachedSnapshot): boolean {
  for (const [filePath, cachedMtime] of snap.mtimes) {
    try {
      const currentMtime = statSync(filePath).mtimeMs;
      if (cachedMtime === MISSING_SENTINEL || currentMtime !== cachedMtime) {
        return true;
      }
    } catch {
      // file doesn't exist on disk — stale only if it was present before
      if (cachedMtime !== MISSING_SENTINEL) {
        return true;
      }
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
