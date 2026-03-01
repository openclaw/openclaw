import { loadWorkspaceBootstrapFiles, type WorkspaceBootstrapFile } from "./workspace.js";

type BootstrapCacheEntry = {
  files: WorkspaceBootstrapFile[];
  loadedAtMs: number;
};

const DEFAULT_BOOTSTRAP_CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, BootstrapCacheEntry>();

function resolveBootstrapCacheTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.OPENCLAW_BOOTSTRAP_CACHE_TTL_MS?.trim();
  if (raw === "") {
    return DEFAULT_BOOTSTRAP_CACHE_TTL_MS;
  }
  if (!raw) {
    return DEFAULT_BOOTSTRAP_CACHE_TTL_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_BOOTSTRAP_CACHE_TTL_MS;
  }
  return Math.max(0, parsed);
}

export async function getOrLoadBootstrapFiles(params: {
  workspaceDir: string;
  sessionKey: string;
}): Promise<WorkspaceBootstrapFile[]> {
  const ttlMs = resolveBootstrapCacheTtlMs();
  const existing = cache.get(params.sessionKey);
  if (existing && ttlMs > 0 && Date.now() - existing.loadedAtMs <= ttlMs) {
    return existing.files;
  }

  const files = await loadWorkspaceBootstrapFiles(params.workspaceDir);
  if (ttlMs > 0) {
    cache.set(params.sessionKey, { files, loadedAtMs: Date.now() });
  }
  return files;
}

export function clearBootstrapSnapshot(sessionKey: string): void {
  cache.delete(sessionKey);
}

export function clearAllBootstrapSnapshots(): void {
  cache.clear();
}
