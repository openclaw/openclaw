import { loadWorkspaceBootstrapFiles, type WorkspaceBootstrapFile } from "./workspace.js";

const cache = new Map<string, WorkspaceBootstrapFile[]>();

export async function getOrLoadBootstrapFiles(params: {
  workspaceDir: string;
  sessionKey: string;
}): Promise<WorkspaceBootstrapFile[]> {
  const existing = cache.get(params.sessionKey);
  if (existing) {
    return existing;
  }

  const files = await loadWorkspaceBootstrapFiles(params.workspaceDir);
  cache.set(params.sessionKey, files);
  return files;
}

export function clearBootstrapSnapshot(sessionKey: string): void {
  cache.delete(sessionKey);
}

export function clearAllBootstrapSnapshots(): void {
  cache.clear();
}
