import type { EmbeddedContextFile } from "./pi-embedded-helpers.js";
import { loadWorkspaceBootstrapFiles, type WorkspaceBootstrapFile } from "./workspace.js";

type BootstrapSnapshot = {
  workspaceDir: string;
  files: WorkspaceBootstrapFile[];
};

export type BootstrapContextSnapshot = {
  bootstrapFiles: WorkspaceBootstrapFile[];
  contextFiles: EmbeddedContextFile[];
};

const BOOTSTRAP_CONTEXT_CACHE_LIMIT = 128;

const cache = new Map<string, BootstrapSnapshot>();
const contextCache = new Map<string, BootstrapContextSnapshot>();

function bootstrapFilesEqual(
  previous: WorkspaceBootstrapFile[],
  next: WorkspaceBootstrapFile[],
): boolean {
  if (previous.length !== next.length) {
    return false;
  }

  return previous.every((file, index) => {
    const updated = next[index];
    return (
      updated !== undefined &&
      file.name === updated.name &&
      file.path === updated.path &&
      file.content === updated.content &&
      file.missing === updated.missing
    );
  });
}

function cloneContextSnapshot(snapshot: BootstrapContextSnapshot): BootstrapContextSnapshot {
  return {
    bootstrapFiles: snapshot.bootstrapFiles.map((file) => ({ ...file })),
    contextFiles: snapshot.contextFiles.map((file) => ({ ...file })),
  };
}

function rememberContextSnapshot(key: string, snapshot: BootstrapContextSnapshot): void {
  if (contextCache.has(key)) {
    contextCache.delete(key);
  }
  contextCache.set(key, cloneContextSnapshot(snapshot));
  while (contextCache.size > BOOTSTRAP_CONTEXT_CACHE_LIMIT) {
    const oldest = contextCache.keys().next().value;
    if (typeof oldest !== "string") {
      break;
    }
    contextCache.delete(oldest);
  }
}

export function readCachedBootstrapContext(key: string): BootstrapContextSnapshot | undefined {
  if (process.env.OPENCLAW_DISABLE_BOOTSTRAP_CONTEXT_CACHE === "1") {
    return undefined;
  }
  const cached = contextCache.get(key);
  if (!cached) {
    return undefined;
  }
  // Refresh LRU order and protect cached arrays/objects from per-run mutation.
  contextCache.delete(key);
  contextCache.set(key, cached);
  return cloneContextSnapshot(cached);
}

export function writeCachedBootstrapContext(key: string, snapshot: BootstrapContextSnapshot): void {
  if (process.env.OPENCLAW_DISABLE_BOOTSTRAP_CONTEXT_CACHE === "1") {
    return;
  }
  rememberContextSnapshot(key, snapshot);
}

export async function getOrLoadBootstrapFiles(params: {
  workspaceDir: string;
  sessionKey: string;
}): Promise<WorkspaceBootstrapFile[]> {
  const existing = cache.get(params.sessionKey);
  // Refresh per turn so long-lived sessions pick up edits; loadWorkspaceBootstrapFiles
  // handles unchanged file content through its guarded inode/mtime cache.
  const files = await loadWorkspaceBootstrapFiles(params.workspaceDir);
  if (
    existing &&
    existing.workspaceDir === params.workspaceDir &&
    bootstrapFilesEqual(existing.files, files)
  ) {
    return existing.files;
  }

  cache.set(params.sessionKey, { workspaceDir: params.workspaceDir, files });
  clearBootstrapContextSnapshotsForSession(params.sessionKey);
  return files;
}

export function clearBootstrapContextSnapshotsForSession(sessionKey: string): void {
  for (const key of Array.from(contextCache.keys())) {
    if (key.includes(`\"sessionKey\":${JSON.stringify(sessionKey)}`)) {
      contextCache.delete(key);
    }
  }
}

export function clearBootstrapSnapshot(sessionKey: string): void {
  cache.delete(sessionKey);
  clearBootstrapContextSnapshotsForSession(sessionKey);
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
  contextCache.clear();
}

export const __testing = {
  readCachedBootstrapContext,
  writeCachedBootstrapContext,
  clearBootstrapContextSnapshotsForSession,
};
