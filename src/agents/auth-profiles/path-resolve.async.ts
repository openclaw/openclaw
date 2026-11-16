import { isArtifactPreservingStateRead } from "../../state/artifact-preserving-state-reads.js";
import { readConfigMachineStateAsync } from "../../state/config-machine-state-async.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import {
  cacheSharedAuthStoreOwnershipAtPath,
  getPreparedSharedAuthStoreOwnership,
  getSharedAuthStoreOwnershipAtPath,
  noteCommittedSharedAuthStoreOwnershipAtPath,
  parseSharedAuthStoreOwnership,
  SHARED_AUTH_STORE_STATE_KEY,
} from "./path-resolve.js";
import type { SharedAuthStoreOwnership } from "./types.js";

/** Fill the same process-stable owner cache without reading SQLite on the caller. */
export async function resolveSharedAuthStoreOwnershipAsync(
  context: OpenClawStateWorkerContext,
): Promise<SharedAuthStoreOwnership> {
  const databasePath = context.admission.databasePath;
  const cached = getSharedAuthStoreOwnershipAtPath(databasePath);
  if (cached) {
    return cached;
  }
  const value = await readConfigMachineStateAsync(
    SHARED_AUTH_STORE_STATE_KEY,
    { path: databasePath, env: context.environment },
    { artifactPreservingReadOnly: isArtifactPreservingStateRead() },
  );
  context.admission.assertCurrent();
  // An explicit commit/reload while this read waited remains the authoritative owner.
  const current = getSharedAuthStoreOwnershipAtPath(databasePath);
  if (current) {
    return current;
  }
  return cacheSharedAuthStoreOwnershipAtPath(databasePath, value);
}

/** Prepare cold ownership once; warm lifecycle entries consume the published fact directly. */
export async function prepareSharedAuthStoreOwnership(
  env: NodeJS.ProcessEnv = process.env,
): Promise<SharedAuthStoreOwnership> {
  // Capture before the first await so preparation retains its caller's admitted generation.
  return (
    getPreparedSharedAuthStoreOwnership(env) ??
    resolveSharedAuthStoreOwnershipAsync(captureOpenClawStateWorkerContext({ env }))
  );
}

/** Reload shared auth ownership after an explicitly joined auth child mutation. */
export async function reloadSharedAuthStoreOwnership(
  env: NodeJS.ProcessEnv = process.env,
): Promise<SharedAuthStoreOwnership> {
  const context = captureOpenClawStateWorkerContext({ env });
  const value = await readConfigMachineStateAsync(
    SHARED_AUTH_STORE_STATE_KEY,
    { path: context.admission.databasePath, env: context.environment },
    { artifactPreservingReadOnly: isArtifactPreservingStateRead() },
  );
  context.admission.assertCurrent();
  const ownership = parseSharedAuthStoreOwnership(value);
  noteCommittedSharedAuthStoreOwnershipAtPath(ownership, context.admission.databasePath);
  return ownership;
}
