import { resolveAuthProfileStoreKey } from "./path-resolve.js";
import { hasPersistedAuthProfileSecretsStore } from "./persisted.js";
import { hasAnyRuntimeAuthProfileStoreSource } from "./runtime-snapshots.js";

export function hasAnyAuthProfileStoreSource(agentDir?: string): boolean {
  if (hasAnyRuntimeAuthProfileStoreSource(agentDir)) {
    return true;
  }
  if (hasPersistedAuthProfileSecretsStore(agentDir)) {
    return true;
  }

  const storeKey = resolveAuthProfileStoreKey(agentDir);
  const mainStoreKey = resolveAuthProfileStoreKey();
  if (agentDir && storeKey !== mainStoreKey && hasPersistedAuthProfileSecretsStore(undefined)) {
    return true;
  }
  return false;
}
