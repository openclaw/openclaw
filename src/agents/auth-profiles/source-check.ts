import fs from "node:fs";
import { resolveAuthStatePath, resolveAuthStorePath } from "./path-resolve.js";
import { hasAnyRuntimeAuthProfileStoreSource } from "./runtime-snapshots.js";

function hasStoredAuthProfileFiles(agentDir?: string): boolean {
  return (
    fs.existsSync(resolveAuthStorePath(agentDir)) || fs.existsSync(resolveAuthStatePath(agentDir))
  );
}

export function hasAnyAuthProfileStoreSource(agentDir?: string): boolean {
  if (hasAnyRuntimeAuthProfileStoreSource(agentDir)) {
    return true;
  }
  if (hasStoredAuthProfileFiles(agentDir)) {
    return true;
  }

  const authPath = resolveAuthStorePath(agentDir);
  const mainAuthPath = resolveAuthStorePath();
  if (agentDir && authPath !== mainAuthPath && hasStoredAuthProfileFiles(undefined)) {
    return true;
  }
  return false;
}
