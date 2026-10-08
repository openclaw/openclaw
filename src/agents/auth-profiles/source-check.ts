/**
 * Auth-profile source probes for runtime and persisted stores.
 * Source presence selects the canonical loader; it does not resolve credentials.
 */
import path from "node:path";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { cloneEnvWithPlatformSemantics } from "../../config/config-env-vars.js";
import { resolveStateDir } from "../../config/paths.js";
import { withSqliteWorkerCleanupFailure } from "../../infra/sqlite-worker-broker-reply.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { evaluateStoredCredentialEligibility } from "./credential-state.js";
import { hasLegacyAuthProfileCredentialSource } from "./legacy-source-diagnostic.js";
import { withAuthProfileCleanup } from "./operation-cleanup.js";
import {
  resolveSharedAuthStoreOwnershipAsync,
  resolveSharedAuthStorePath,
} from "./path-resolve.js";
import { coercePersistedAuthProfileStore } from "./persisted.js";
import {
  getRuntimeAuthProfileStoreSnapshotCore,
  hasAnyRuntimeAuthProfileStoreSource,
  hasRuntimeAuthProfileStoreSource,
} from "./runtime-snapshots.js";
import { resolveSharedMainAuthAgentDir } from "./shared-main-dir.js";
import { prepareAgentAuthProfileRowsRead, readSharedAuthProfileRows } from "./sqlite-read.js";
import {
  inspectPersistedAuthProfileStoreRaw,
  readPersistedAuthProfileStateRaw,
  resolveAuthProfileDatabasePath,
  resolveAuthProfileDatabaseOwnerId,
} from "./sqlite.js";
import type { AuthProfileRowRead, AuthProfileStore } from "./types.js";

function storeHasProviderProfile(
  store: AuthProfileStore | null,
  provider: string,
  profileIds?: readonly string[],
): boolean {
  const profiles = store?.profiles;
  if (!profiles) {
    return false;
  }
  const expected = normalizeLowercaseStringOrEmpty(provider);
  const credentials =
    profileIds?.map((profileId) => profiles[profileId]) ?? Object.values(profiles);
  return credentials.some(
    (credential) =>
      credential !== undefined &&
      normalizeLowercaseStringOrEmpty(credential.provider) === expected &&
      evaluateStoredCredentialEligibility({ credential }).eligible,
  );
}

function canonicalStoreOwnsProviderRoute(
  agentDir: string | undefined,
  provider: string,
  profileIds?: readonly string[],
): boolean {
  const inspection = inspectPersistedAuthProfileStoreRaw(agentDir);
  if (inspection.status === "missing") {
    return false;
  }
  const store =
    inspection.status === "readable" ? coercePersistedAuthProfileStore(inspection.raw) : null;
  if (!store) {
    // A present but unreadable canonical row must route through the loader so
    // AUTH_PROFILE_STORE_UNREADABLE fails closed before env/config fallback.
    return true;
  }
  return storeHasProviderProfile(store, provider, profileIds);
}

/** Synchronous Doctor/CLI and released coding-tool construction compatibility. */
export function hasAnyAuthProfileStoreSource(agentDir?: string): boolean {
  if (hasLocalAuthProfileStoreSource(agentDir) || hasAnyRuntimeAuthProfileStoreSource(agentDir)) {
    return true;
  }

  const authPath = agentDir
    ? resolveAuthProfileDatabasePath(agentDir)
    : resolveSharedAuthStorePath();
  const mainAuthPath = resolveSharedAuthStorePath();
  if (
    agentDir &&
    authPath !== mainAuthPath &&
    (hasLegacyAuthProfileCredentialSource(undefined) ||
      inspectPersistedAuthProfileStoreRaw(undefined).status !== "missing" ||
      readPersistedAuthProfileStateRaw(undefined))
  ) {
    return true;
  }
  return false;
}

/** Runtime source detection retains the existing readers through classification and cleanup. */
export async function hasAnyAuthProfileStoreSourceAsync(agentDir?: string): Promise<boolean> {
  const env = cloneEnvWithPlatformSemantics(process.env);
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const localPath = agentDir ? resolveAuthProfileDatabasePath(agentDir) : undefined;
  const localDir = localPath ? path.dirname(localPath) : undefined;
  if (
    localDir &&
    (hasRuntimeAuthProfileStoreSource(localDir, env) ||
      hasLegacyAuthProfileCredentialSource(localDir, env))
  ) {
    return true;
  }
  const context = captureOpenClawStateWorkerContext({ env });
  const legacySharedPath = resolveAuthProfileDatabasePath(resolveSharedMainAuthAgentDir(env));
  // Capture both possible shared owners before the first read can yield.
  const readers = new Map(
    [...new Set([legacySharedPath, ...(localPath ? [localPath] : [])])].map((databasePath) => [
      databasePath,
      prepareAgentAuthProfileRowsRead({
        databasePath,
        agentId: resolveAuthProfileDatabaseOwnerId(path.dirname(databasePath)),
        env,
      }),
    ]),
  );
  const usedReaders = new Set<ReturnType<typeof prepareAgentAuthProfileRowsRead>>();
  let usedShared = false;
  const readAgent = (databasePath: string) => {
    const reader = readers.get(databasePath)!;
    usedReaders.add(reader);
    return reader.read();
  };
  const hasSource = (rows: AuthProfileRowRead): boolean =>
    rows.store.status !== "missing" ||
    (rows.state.status === "readable" && Boolean(rows.state.raw));
  const readSource = async () => {
    if (localPath && hasSource(await readAgent(localPath))) {
      return true;
    }
    usedShared = true;
    const ownership = await resolveSharedAuthStoreOwnershipAsync(context);
    if (
      (localDir && hasRuntimeAuthProfileStoreSource(localDir, env)) ||
      hasRuntimeAuthProfileStoreSource(undefined, env)
    ) {
      return true;
    }
    const sharedPath =
      ownership.location === "state-db" ? context.admission.databasePath : legacySharedPath;
    if (localPath === sharedPath) {
      return false;
    }
    if (hasLegacyAuthProfileCredentialSource(undefined, env)) {
      return true;
    }
    return hasSource(
      ownership.location === "state-db"
        ? await readSharedAuthProfileRows(context)
        : await readAgent(sharedPath),
    );
  };
  const result = await withAuthProfileCleanup(readSource, async (outcome) => {
    const cleanup = await Promise.allSettled(
      [...readers.values()].map((reader) => reader.dispose()),
    );
    const failures = cleanup.flatMap((entry) =>
      entry.status === "rejected" ? [entry.reason] : [],
    );
    if (failures.length) {
      const error =
        failures.length === 1
          ? failures[0]
          : new AggregateError(failures, "Auth source reader cleanup failed", {
              cause: failures[0],
            });
      throw outcome.ok
        ? error
        : withSqliteWorkerCleanupFailure(
            toErrorObject(outcome.error, "Auth source read failed"),
            error,
          );
    }
  });
  for (const reader of usedReaders) {
    reader.assertCurrent();
  }
  if (usedShared) {
    context.maintenanceScope?.assertAdmission();
    context.admission.assertCurrent();
  }
  return result;
}

/** Returns true when the requested agent dir has a local auth profile source. */
export function hasLocalAuthProfileStoreSource(agentDir?: string): boolean {
  return (
    hasRuntimeAuthProfileStoreSource(agentDir) ||
    hasLegacyAuthProfileCredentialSource(agentDir) ||
    inspectPersistedAuthProfileStoreRaw(agentDir).status !== "missing" ||
    Boolean(readPersistedAuthProfileStateRaw(agentDir))
  );
}

type AuthProfileSourceForProviderOptions = {
  /** Optional hard order/profile constraint from config auth.order. */
  profileIds?: readonly string[];
};

/** Returns true when a read-only auth-profile source contains a profile for a provider. */
export function hasAuthProfileStoreSourceForProvider(
  provider: string,
  agentDir?: string,
  options?: AuthProfileSourceForProviderOptions,
): boolean {
  if (!normalizeLowercaseStringOrEmpty(provider)) {
    return false;
  }
  const profileIds = options?.profileIds;
  if (profileIds?.length === 0) {
    return false;
  }
  // A retired credential source is intentionally opaque to runtime. Treat it
  // as potentially owning the provider so the canonical loader can fail closed
  // with AUTH_PROFILE_MIGRATION_REQUIRED instead of falling through to env auth.
  const ownsProvider = (ownerAgentDir: string | undefined) =>
    storeHasProviderProfile(
      coercePersistedAuthProfileStore(getRuntimeAuthProfileStoreSnapshotCore(ownerAgentDir)),
      provider,
      profileIds,
    ) ||
    hasLegacyAuthProfileCredentialSource(ownerAgentDir) ||
    canonicalStoreOwnsProviderRoute(ownerAgentDir, provider, profileIds);
  return ownsProvider(agentDir) || (Boolean(agentDir) && ownsProvider(undefined));
}
