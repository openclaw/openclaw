import { statSync } from "node:fs";
import path from "node:path";
import {
  DEFAULT_MEMORY_ALT_FILENAME,
  DEFAULT_MEMORY_FILENAME,
  loadWorkspaceBootstrapFiles,
  type WorkspaceBootstrapFile,
} from "./workspace.js";

interface CachedSnapshot {
  files: WorkspaceBootstrapFile[];
  /** file path → mtimeMs at the time of caching */
  mtimes: Map<string, number>;
}

const cache = new Map<string, CachedSnapshot>();

const MISSING_SENTINEL = -1;

/**
 * Optional bootstrap files that `loadWorkspaceBootstrapFiles` only includes
 * when they exist on disk. We watch their paths even when absent so that
 * creating one mid-session invalidates the cache.
 */
const OPTIONAL_BOOTSTRAP_FILENAMES = [DEFAULT_MEMORY_FILENAME, DEFAULT_MEMORY_ALT_FILENAME];

/** Capture mtimeMs for each bootstrap file (missing files use a sentinel). */
function snapshotMtimes(
  files: WorkspaceBootstrapFile[],
  workspaceDir: string,
): Map<string, number> {
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
  // Seed optional files that may not be in the list yet.
  // Use stat (not a blind sentinel) so case-insensitive filesystems (macOS)
  // don't false-positive when e.g. MEMORY.md exists but memory.md is seeded.
  for (const name of OPTIONAL_BOOTSTRAP_FILENAMES) {
    const filePath = path.join(workspaceDir, name);
    if (!m.has(filePath)) {
      try {
        m.set(filePath, statSync(filePath).mtimeMs);
      } catch {
        m.set(filePath, MISSING_SENTINEL);
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
  cache.set(params.sessionKey, { files, mtimes: snapshotMtimes(files, params.workspaceDir) });
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
