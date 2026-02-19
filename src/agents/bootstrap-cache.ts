import { loadWorkspaceBootstrapFiles, type WorkspaceBootstrapFile } from "./workspace.js";

type BootstrapCacheEntry = {
  files: WorkspaceBootstrapFile[];
  workspaceDir: string;
};

const cache = new Map<string, BootstrapCacheEntry>();

export async function getOrLoadBootstrapFiles(params: {
  workspaceDir: string;
  sessionKey: string;
}): Promise<WorkspaceBootstrapFile[]> {
  const existing = cache.get(params.sessionKey);
  if (existing) {
    // Bypass cache if workspaceDir changed (shouldn't happen in practice)
    if (existing.workspaceDir === params.workspaceDir) {
      return existing.files;
    }
    cache.delete(params.sessionKey);
  }

  const files = await loadWorkspaceBootstrapFiles(params.workspaceDir);
  cache.set(params.sessionKey, { files, workspaceDir: params.workspaceDir });
  return files;
}

export function clearBootstrapSnapshot(sessionKey: string): void {
  cache.delete(sessionKey);
}

export function clearAllBootstrapSnapshots(): void {
  cache.clear();
}
