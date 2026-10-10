import path from "node:path";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import {
  withCanonicalAuthProfileCredentialObserver,
  type CanonicalAuthProfileCredentialObservation,
} from "./auth-profiles/credential-observation.js";
import { resolveSharedAuthStoreOwnershipAsync } from "./auth-profiles/path-resolve.js";
import { resolveSharedMainAuthAgentDir } from "./auth-profiles/shared-main-dir.js";
import {
  loadPersistedAuthProfileStoreFromRows,
  prepareAgentAuthProfileRowsRead,
  readSharedAuthProfileRows,
} from "./auth-profiles/sqlite-read.js";
import {
  resolveAuthProfileDatabaseOwnerId,
  resolveAuthProfileDatabasePath,
} from "./auth-profiles/sqlite.js";
import type { AuthProfileCredential, AuthProfileRowRead } from "./auth-profiles/types.js";

export type PluginModelCatalogAuthSnapshot = Array<{
  databasePath: string;
  kind: "agent" | "shared-state";
  credentials: Record<string, string[]>;
}>;

export function pluginModelCatalogCredentialValues(
  credential: AuthProfileCredential | undefined,
): string[] {
  if (!credential) {
    return [];
  }
  const values =
    credential.type === "api_key"
      ? [credential.key]
      : credential.type === "token"
        ? [credential.token]
        : [credential.access, credential.refresh];
  return values.filter((value): value is string => typeof value === "string" && value.length > 0);
}

/** Retain credentials acquired during discovery, even if logout removes them before it settles. */
export async function withPluginModelCatalogAuthObservations<T>(
  snapshot: PluginModelCatalogAuthSnapshot,
  run: () => Promise<T>,
): Promise<T> {
  const captured = new Map(
    snapshot.map((owner) => [
      path.resolve(owner.databasePath),
      new Map(Object.entries(owner.credentials).map(([id, values]) => [id, new Set(values)])),
    ]),
  );
  const result = await withCanonicalAuthProfileCredentialObserver(
    ({ databasePath, profiles }: CanonicalAuthProfileCredentialObservation) => {
      const owner = captured.get(path.resolve(databasePath));
      if (!owner) {
        return;
      }
      for (const [id, credential] of Object.entries(profiles)) {
        const values = owner.get(id) ?? new Set<string>();
        for (const value of pluginModelCatalogCredentialValues(credential)) {
          values.add(value);
        }
        owner.set(id, values);
      }
    },
    run,
  );
  for (const owner of snapshot) {
    owner.credentials = Object.fromEntries(
      [...captured.get(path.resolve(owner.databasePath))!].map(([id, values]) => [id, [...values]]),
    );
  }
  return result;
}

/** Capture only existing canonical owners; catalog-only credentials retain their recovery policy. */
export async function capturePluginModelCatalogAuth(
  agentDir: string,
  env: NodeJS.ProcessEnv,
): Promise<PluginModelCatalogAuthSnapshot> {
  const capturedEnv = cloneEnvWithPlatformSemantics(env);
  const state = captureOpenClawStateWorkerContext({ env: capturedEnv });
  const sharedDir = resolveSharedMainAuthAgentDir(capturedEnv);
  const localPath = resolveAuthProfileDatabasePath(agentDir);
  const sharedOwnership = await resolveSharedAuthStoreOwnershipAsync(state);
  const sharedPath =
    sharedOwnership.location === "state-db"
      ? state.admission.databasePath
      : resolveAuthProfileDatabasePath(sharedDir);
  const owners: Array<{
    databasePath: string;
    kind: "agent" | "shared-state";
    agentDir: string;
  }> = [
    {
      databasePath: sharedPath,
      kind: sharedOwnership.location === "state-db" ? "shared-state" : "agent",
      agentDir: sharedDir,
    },
    ...(localPath === sharedPath
      ? []
      : [{ databasePath: localPath, kind: "agent" as const, agentDir }]),
  ];
  const snapshot: PluginModelCatalogAuthSnapshot = [];
  for (const owner of owners) {
    const reader =
      owner.kind === "agent"
        ? prepareAgentAuthProfileRowsRead({
            databasePath: owner.databasePath,
            agentId: resolveAuthProfileDatabaseOwnerId(owner.agentDir),
            env: capturedEnv,
          })
        : undefined;
    let rows: AuthProfileRowRead;
    try {
      rows = reader ? await reader.read() : await readSharedAuthProfileRows(state);
      state.admission.assertCurrent();
    } finally {
      await reader?.dispose();
    }
    const store = loadPersistedAuthProfileStoreFromRows(rows, owner.databasePath);
    snapshot.push({
      databasePath: owner.databasePath,
      kind: owner.kind,
      credentials: Object.fromEntries(
        Object.entries(store?.profiles ?? {}).map(([id, credential]) => [
          id,
          pluginModelCatalogCredentialValues(credential),
        ]),
      ),
    });
  }
  return snapshot;
}
