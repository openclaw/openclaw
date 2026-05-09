import { resolveAuthStorePath } from "./path-resolve.js";
import { hasPersistedAuthProfileSecretsStore } from "./persisted.js";
import { hasAnyRuntimeAuthProfileStoreSource } from "./runtime-snapshots.js";

export function hasAnyAuthProfileStoreSource(agentDir?: string): boolean {
  if (hasAnyRuntimeAuthProfileStoreSource(agentDir)) {
    return true;
  }
  if (hasPersistedAuthProfileSecretsStore(agentDir)) {
    return true;
  }

  const authPath = resolveAuthStorePath(agentDir);
  const mainAuthPath = resolveAuthStorePath();
  if (agentDir && authPath !== mainAuthPath && hasPersistedAuthProfileSecretsStore(undefined)) {
    return true;
  }
  return false;
}
