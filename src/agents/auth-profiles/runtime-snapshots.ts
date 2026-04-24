import fs from "node:fs";
import { resolveAuthStorePath } from "./path-resolve.js";
import type { AuthProfileStore } from "./types.js";

const runtimeAuthStoreSnapshots = new Map<string, AuthProfileStore>();
const runtimeAuthStoreSnapshotLoadedAtMsByKey = new Map<string, number>();

export type RuntimeAuthProfileStoreSnapshotResult =
  | { status: "hit"; store: AuthProfileStore }
  | { status: "miss" }
  | { status: "stale" };

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
  if (!runtimeAuthStoreSnapshots.has(storeKey)) {
    return false;
  }
  const loadedAtMs = runtimeAuthStoreSnapshotLoadedAtMsByKey.get(storeKey) ?? 0;
  if (loadedAtMs <= 0) {
    return false;
  }
  const mtimeMs = readAuthStoreMtimeMs(storeKey);
  if (mtimeMs === null || mtimeMs <= loadedAtMs) {
    return false;
  }
  clearRuntimeAuthProfileStoreSnapshots();
  return true;
}

export function getRuntimeAuthProfileStoreSnapshot(
  agentDir?: string,
): AuthProfileStore | undefined {
  const result = getRuntimeAuthProfileStoreSnapshotResult(agentDir);
  return result.status === "hit" ? result.store : undefined;
}

export function getRuntimeAuthProfileStoreSnapshotResult(
  agentDir?: string,
): RuntimeAuthProfileStoreSnapshotResult {
  const storeKey = resolveRuntimeStoreKey(agentDir);
  if (clearStaleRuntimeSnapshotsIfNeeded(storeKey)) {
    return { status: "stale" };
  }
  const store = runtimeAuthStoreSnapshots.get(storeKey);
  return store ? { status: "hit", store: cloneAuthProfileStore(store) } : { status: "miss" };
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
  runtimeAuthStoreSnapshotLoadedAtMsByKey.clear();
  for (const entry of entries) {
    const storeKey = resolveRuntimeStoreKey(entry.agentDir);
    runtimeAuthStoreSnapshots.set(storeKey, cloneAuthProfileStore(entry.store));
    runtimeAuthStoreSnapshotLoadedAtMsByKey.set(storeKey, loadedAtMs);
  }
}

export function clearRuntimeAuthProfileStoreSnapshots(): void {
  runtimeAuthStoreSnapshots.clear();
  runtimeAuthStoreSnapshotLoadedAtMsByKey.clear();
}

export function setRuntimeAuthProfileStoreSnapshot(
  store: AuthProfileStore,
  agentDir?: string,
): void {
  const storeKey = resolveRuntimeStoreKey(agentDir);
  runtimeAuthStoreSnapshots.set(storeKey, cloneAuthProfileStore(store));
  runtimeAuthStoreSnapshotLoadedAtMsByKey.set(storeKey, Date.now());
}

export function updateRuntimeAuthProfileStoreSnapshotIfPresent(
  store: AuthProfileStore,
  agentDir?: string,
): boolean {
  const storeKey = resolveRuntimeStoreKey(agentDir);
  if (!runtimeAuthStoreSnapshots.has(storeKey)) {
    return false;
  }
  runtimeAuthStoreSnapshots.set(storeKey, cloneAuthProfileStore(store));
  runtimeAuthStoreSnapshotLoadedAtMsByKey.set(storeKey, Date.now());
  return true;
}
