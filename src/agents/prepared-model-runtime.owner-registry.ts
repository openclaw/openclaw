import type {
  PreparedModelRuntimeOwner,
  PreparedModelRuntimeSnapshot,
} from "./prepared-model-runtime.types.js";

const ownersBySnapshot = new WeakMap<PreparedModelRuntimeSnapshot, PreparedModelRuntimeOwner>();

export function resolvePreparedModelRuntimeOwnerBySnapshot(
  snapshot: PreparedModelRuntimeSnapshot,
): PreparedModelRuntimeOwner | undefined {
  return ownersBySnapshot.get(snapshot);
}

export function registerPreparedModelRuntimeSnapshotOwner(
  snapshot: PreparedModelRuntimeSnapshot,
  owner: PreparedModelRuntimeOwner,
): void {
  ownersBySnapshot.set(snapshot, owner);
}

export function unregisterPreparedModelRuntimeSnapshotOwner(
  snapshot: PreparedModelRuntimeSnapshot,
): void {
  ownersBySnapshot.delete(snapshot);
}
