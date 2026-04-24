import fs from "node:fs";
import { resolveAuthStorePath } from "./path-resolve.js";
import type { AuthProfileStore } from "./types.js";

const runtimeAuthStoreSnapshots = new Map<string, AuthProfileStore>();
let runtimeAuthStoreSnapshotsLoadedAtMs = 0;

function resolveRuntimeStoreKey(agentDir?: string): string {
  return resolveAuthStorePath(agentDir);
}

function cloneAuthProfileStore(store: AuthProfileStore): AuthProfileStore {
  return structuredClone(store);
}

function readAuthStoreMtimeMs(authPath: string): number | null {
  try {
    return fs.statSync(authPath).mtimeMs;
  } catch {
    return null;
  }
}

function clearStaleRuntimeSnapshotsIfNeeded(storeKey: string): boolean {
  if (runtimeAuthStoreSnapshotsLoadedAtMs <= 0) {
    return false;
  }
  const mtimeMs = readAuthStoreMtimeMs(storeKey);
  if (mtimeMs === null || mtimeMs <= runtimeAuthStoreSnapshotsLoadedAtMs) {
    return false;
  }
  clearRuntimeAuthProfileStoreSnapshots();
  return true;
}

export function getRuntimeAuthProfileStoreSnapshot(
  agentDir?: string,
): AuthProfileStore | undefined {
  const storeKey = resolveRuntimeStoreKey(agentDir);
  if (clearStaleRuntimeSnapshotsIfNeeded(storeKey)) {
    return undefined;
  }
  const store = runtimeAuthStoreSnapshots.get(storeKey);
  return store ? cloneAuthProfileStore(store) : undefined;
}

export function hasRuntimeAuthProfileStoreSnapshot(agentDir?: string): boolean {
  const storeKey = resolveRuntimeStoreKey(agentDir);
  if (clearStaleRuntimeSnapshotsIfNeeded(storeKey)) {
    return false;
  }
  return runtimeAuthStoreSnapshots.has(storeKey);
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
  loadedAtMs = Date.now(),
): void {
  runtimeAuthStoreSnapshots.clear();
  runtimeAuthStoreSnapshotsLoadedAtMs = loadedAtMs;
  for (const entry of entries) {
    runtimeAuthStoreSnapshots.set(
      resolveRuntimeStoreKey(entry.agentDir),
      cloneAuthProfileStore(entry.store),
    );
  }
}

export function clearRuntimeAuthProfileStoreSnapshots(): void {
  runtimeAuthStoreSnapshots.clear();
  runtimeAuthStoreSnapshotsLoadedAtMs = 0;
}

export function setRuntimeAuthProfileStoreSnapshot(
  store: AuthProfileStore,
  agentDir?: string,
): void {
  runtimeAuthStoreSnapshotsLoadedAtMs = Date.now();
  runtimeAuthStoreSnapshots.set(resolveRuntimeStoreKey(agentDir), cloneAuthProfileStore(store));
}
