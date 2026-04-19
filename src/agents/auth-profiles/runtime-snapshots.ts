import fs from "node:fs";
import { resolveAuthStatePath, resolveAuthStorePath } from "./path-resolve.js";
import type { AuthProfileStore } from "./types.js";

type RuntimeAuthProfileStoreSnapshot = {
  authMtimeMs: number | null;
  stateMtimeMs: number | null;
  store: AuthProfileStore;
};

const runtimeAuthStoreSnapshots = new Map<string, RuntimeAuthProfileStoreSnapshot>();

function resolveRuntimeStoreKey(agentDir?: string): string {
  return resolveAuthStorePath(agentDir);
}

function cloneAuthProfileStore(store: AuthProfileStore): AuthProfileStore {
  return structuredClone(store);
}

function readAuthStoreMtimeMs(pathname: string): number | null {
  try {
    return fs.statSync(pathname).mtimeMs;
  } catch {
    return null;
  }
}

function createRuntimeAuthProfileStoreSnapshot(
  store: AuthProfileStore,
  agentDir?: string,
): RuntimeAuthProfileStoreSnapshot {
  return {
    authMtimeMs: readAuthStoreMtimeMs(resolveAuthStorePath(agentDir)),
    stateMtimeMs: readAuthStoreMtimeMs(resolveAuthStatePath(agentDir)),
    store: cloneAuthProfileStore(store),
  };
}

function getFreshRuntimeAuthProfileStoreSnapshot(
  agentDir?: string,
): RuntimeAuthProfileStoreSnapshot | undefined {
  const key = resolveRuntimeStoreKey(agentDir);
  const snapshot = runtimeAuthStoreSnapshots.get(key);
  if (!snapshot) {
    return undefined;
  }
  const authMtimeMs = readAuthStoreMtimeMs(resolveAuthStorePath(agentDir));
  const stateMtimeMs = readAuthStoreMtimeMs(resolveAuthStatePath(agentDir));
  if (snapshot.authMtimeMs !== authMtimeMs || snapshot.stateMtimeMs !== stateMtimeMs) {
    runtimeAuthStoreSnapshots.delete(key);
    return undefined;
  }
  return snapshot;
}

export function getRuntimeAuthProfileStoreSnapshot(
  agentDir?: string,
): AuthProfileStore | undefined {
  const snapshot = getFreshRuntimeAuthProfileStoreSnapshot(agentDir);
  return snapshot ? cloneAuthProfileStore(snapshot.store) : undefined;
}

export function hasRuntimeAuthProfileStoreSnapshot(agentDir?: string): boolean {
  return Boolean(getFreshRuntimeAuthProfileStoreSnapshot(agentDir));
}

export function hasAnyRuntimeAuthProfileStoreSource(agentDir?: string): boolean {
  const requestedStore = getRuntimeAuthProfileStoreSnapshot(agentDir);
  if (requestedStore && Object.keys(requestedStore.profiles).length > 0) {
    return true;
  }
  if (!agentDir) {
    return false;
  }
  const mainStore = getRuntimeAuthProfileStoreSnapshot();
  return Boolean(mainStore && Object.keys(mainStore.profiles).length > 0);
}

export function replaceRuntimeAuthProfileStoreSnapshots(
  entries: Array<{ agentDir?: string; store: AuthProfileStore }>,
): void {
  runtimeAuthStoreSnapshots.clear();
  for (const entry of entries) {
    runtimeAuthStoreSnapshots.set(
      resolveRuntimeStoreKey(entry.agentDir),
      createRuntimeAuthProfileStoreSnapshot(entry.store, entry.agentDir),
    );
  }
}

export function clearRuntimeAuthProfileStoreSnapshots(): void {
  runtimeAuthStoreSnapshots.clear();
}

export function setRuntimeAuthProfileStoreSnapshot(
  store: AuthProfileStore,
  agentDir?: string,
): void {
  runtimeAuthStoreSnapshots.set(
    resolveRuntimeStoreKey(agentDir),
    createRuntimeAuthProfileStoreSnapshot(store, agentDir),
  );
}
