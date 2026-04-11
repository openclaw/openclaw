import { loadWorkspaceBootstrapFiles, type WorkspaceBootstrapFile } from "./workspace.js";

const cache = new Map<string, WorkspaceBootstrapFile[]>();

function bootstrapFileEquals(
  current: WorkspaceBootstrapFile,
  next: WorkspaceBootstrapFile,
): boolean {
  return (
    current.name === next.name &&
    current.path === next.path &&
    current.missing === next.missing &&
    current.content === next.content
  );
}

function bootstrapSnapshotEquals(
  current: WorkspaceBootstrapFile[],
  next: WorkspaceBootstrapFile[],
): boolean {
  if (current.length !== next.length) {
    return false;
  }
  return current.every((file, index) => bootstrapFileEquals(file, next[index]));
}

export async function getOrLoadBootstrapFiles(params: {
  workspaceDir: string;
  sessionKey: string;
}): Promise<WorkspaceBootstrapFile[]> {
  const files = await loadWorkspaceBootstrapFiles(params.workspaceDir);
  const existing = cache.get(params.sessionKey);
  if (existing && bootstrapSnapshotEquals(existing, files)) {
    return existing;
  }
  cache.set(params.sessionKey, files);
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
