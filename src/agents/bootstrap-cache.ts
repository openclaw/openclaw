import { stat } from "node:fs/promises";
import { loadWorkspaceBootstrapFiles, type WorkspaceBootstrapFile } from "./workspace.js";

type CacheEntry = {
  files: WorkspaceBootstrapFile[];
  /** mtime (ms) per file path at the time of caching. */
  mtimes: Map<string, number>;
  cachedAt: number;
};

const cache = new Map<string, CacheEntry>();

const STALE_TTL_MS = 5 * 60_000;

async function collectMtimes(files: WorkspaceBootstrapFile[]): Promise<Map<string, number>> {
  const mtimes = new Map<string, number>();
  const tasks = files
    .filter((f) => !f.missing)
    .map(async (f) => {
      try {
        const s = await stat(f.path);
        mtimes.set(f.path, s.mtimeMs);
      } catch {
        // File may have been removed since last load; treat as changed.
      }
    });
  await Promise.all(tasks);
  return mtimes;
}

async function isStale(entry: CacheEntry): Promise<boolean> {
  if (Date.now() - entry.cachedAt > STALE_TTL_MS) {
    return true;
  }

  const currentMtimes = await collectMtimes(entry.files);

  for (const [filePath, cachedMtime] of entry.mtimes) {
    const current = currentMtimes.get(filePath);
    if (current === undefined || current !== cachedMtime) {
      return true;
    }
  }

  if (currentMtimes.size !== entry.mtimes.size) {
    return true;
  }

  return false;
}

export async function getOrLoadBootstrapFiles(params: {
  workspaceDir: string;
  sessionKey: string;
}): Promise<WorkspaceBootstrapFile[]> {
  const existing = cache.get(params.sessionKey);
  if (existing && !(await isStale(existing))) {
    return existing.files;
  }

  const files = await loadWorkspaceBootstrapFiles(params.workspaceDir);
  const mtimes = await collectMtimes(files);
  cache.set(params.sessionKey, { files, mtimes, cachedAt: Date.now() });
  return files;
}

export function clearBootstrapSnapshot(sessionKey: string): void {
  cache.delete(sessionKey);
}

export function clearAllBootstrapSnapshots(): void {
  cache.clear();
}
