import path from "node:path";
import type { Result } from "@openclaw/normalization-core/result";
import {
  AgentDatabaseAdmissionError,
  readAgentDatabaseAdmissionRefusal,
} from "../../state/agent-database-admission.js";
import { isSameOpenClawAgentDatabasePath } from "../../state/openclaw-agent-db.paths.js";
import { resolveSharedAuthStoreOwnership, resolveSharedAuthStorePath } from "./path-resolve.js";
import { mergeAuthProfileStores } from "./persisted.js";
import { getRuntimeAuthProfileStoreSnapshotAtDatabasePath } from "./runtime-snapshots.js";
import { resolveAuthProfileDatabaseOwnerId, resolveAuthProfileDatabasePath } from "./sqlite.js";
import { AuthProfileStoreUnreadableError } from "./store-unreadable-error.js";
import type { AuthProfileStore } from "./types.js";

/** Keep local auth available while an inherited owner is pending or unreadable and refused. */
export function loadInheritedAuthProfileStore(
  read: () => AuthProfileStore,
  agentDir?: string,
  env: NodeJS.ProcessEnv = process.env,
): AuthProfileStore | undefined {
  try {
    return read();
  } catch (error) {
    const failedPaths =
      error instanceof AuthProfileStoreUnreadableError
        ? [error.databasePath]
        : error instanceof AgentDatabaseAdmissionError &&
            error.refusal.code === "agent-database-inspection-pending"
          ? error.refusal.paths
          : undefined;
    if (
      !failedPaths ||
      (!agentDir && resolveSharedAuthStoreOwnership(env).location !== "legacy-main")
    ) {
      throw error;
    }
    const databasePath = agentDir
      ? resolveAuthProfileDatabasePath(agentDir)
      : resolveSharedAuthStorePath(env);
    const ownerId = resolveAuthProfileDatabaseOwnerId(agentDir ?? path.dirname(databasePath));
    const refusal = readAgentDatabaseAdmissionRefusal(ownerId, { env });
    const isOwnerPath = (pathname: string) =>
      isSameOpenClawAgentDatabasePath(pathname, databasePath);
    if (
      !failedPaths.some(isOwnerPath) ||
      !refusal?.paths.some(isOwnerPath) ||
      (error instanceof AgentDatabaseAdmissionError &&
        (error.refusal.agentId !== ownerId || refusal.code !== "agent-database-inspection-pending"))
    ) {
      throw error;
    }
    return undefined;
  }
}

type RuntimeAuthSnapshotReadScope = {
  agentDir?: string;
  inheritedAuthDir?: string;
  env?: NodeJS.ProcessEnv;
  sharedPath?: string;
};

function readResult(result: Result<AuthProfileStore, unknown>): AuthProfileStore {
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

/** One lazy snapshot policy; adapters supply only the demanded persisted reads. */
export function* readRuntimeAuthProfileStoreFromSnapshots(
  params: RuntimeAuthSnapshotReadScope,
): Generator<{ agentDir?: string }, AuthProfileStore | null, Result<AuthProfileStore, unknown>> {
  const mainKey = params.inheritedAuthDir
    ? resolveAuthProfileDatabasePath(params.inheritedAuthDir)
    : (params.sharedPath ?? resolveSharedAuthStorePath(params.env));
  const requestedKey = params.agentDir
    ? resolveAuthProfileDatabasePath(params.agentDir)
    : (params.sharedPath ?? resolveSharedAuthStorePath(params.env));
  const mainStore = getRuntimeAuthProfileStoreSnapshotAtDatabasePath(mainKey);
  if (!params.agentDir || requestedKey === mainKey) {
    return mainStore ?? null;
  }
  const requestedStore = getRuntimeAuthProfileStoreSnapshotAtDatabasePath(requestedKey);
  if (mainStore && requestedStore) {
    return mergeAuthProfileStores(mainStore, requestedStore, {
      preserveBaseRuntimeExternalProfiles: true,
    });
  }
  if (requestedStore) {
    const result = yield { agentDir: params.inheritedAuthDir };
    const persistedMainStore = loadInheritedAuthProfileStore(
      () => readResult(result),
      params.inheritedAuthDir,
      params.env,
    );
    return persistedMainStore
      ? mergeAuthProfileStores(persistedMainStore, requestedStore, {
          preserveBaseRuntimeExternalProfiles: true,
        })
      : requestedStore;
  }
  if (!mainStore) {
    return null;
  }
  const result = yield { agentDir: params.agentDir };
  return mergeAuthProfileStores(mainStore, readResult(result), {
    preserveBaseRuntimeExternalProfiles: true,
  });
}
