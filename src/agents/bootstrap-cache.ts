import {
  loadWorkspaceBootstrapFiles,
  loadWorkspaceBootstrapFilesWithChannel,
  type WorkspaceBootstrapFile,
} from "./workspace.js";

const cache = new Map<string, WorkspaceBootstrapFile[]>();

function buildBootstrapCacheKey(params: {
  sessionKey: string;
  workspaceDir: string;
  channel?: string;
  accountId?: string;
  soulFile?: string;
}): string {
  return JSON.stringify({
    sessionKey: params.sessionKey,
    workspaceDir: params.workspaceDir,
    channel: params.channel ?? null,
    accountId: params.accountId ?? null,
    soulFile: params.soulFile ?? null,
  });
}

export async function getOrLoadBootstrapFiles(params: {
  workspaceDir: string;
  sessionKey: string;
  channel?: string;
  accountId?: string;
  soulFile?: string;
}): Promise<WorkspaceBootstrapFile[]> {
  const cacheKey = buildBootstrapCacheKey(params);
  const existing = cache.get(cacheKey);
  if (existing) {
    return existing;
  }

  const files =
    params.channel || params.accountId || params.soulFile
      ? await loadWorkspaceBootstrapFilesWithChannel({
          dir: params.workspaceDir,
          channel: params.channel,
          accountId: params.accountId,
          soulFile: params.soulFile,
        })
      : await loadWorkspaceBootstrapFiles(params.workspaceDir);
  cache.set(cacheKey, files);
  return files;
}

export function clearBootstrapSnapshot(sessionKey: string): void {
  for (const key of cache.keys()) {
    try {
      const parsed = JSON.parse(key) as { sessionKey?: string };
      if (parsed.sessionKey === sessionKey) {
        cache.delete(key);
      }
    } catch {
      if (key === sessionKey) {
        cache.delete(key);
      }
    }
  }
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
