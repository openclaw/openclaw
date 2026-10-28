import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { cloneEnvWithPlatformSemantics } from "../../config/config-env-vars.js";
import { resolveStateDir } from "../../config/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolvePathViaExistingAncestorSync } from "../../infra/boundary-path.js";
import { isErrno } from "../../infra/errno.js";
import {
  assertDatabasePathIdentity,
  readDatabasePathIdentitySync,
  type DatabasePathIdentity,
} from "../../infra/sqlite-worker-identity.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { listOpenClawRegisteredAgentDatabasesAsync } from "../../state/openclaw-agent-db-registry-listing.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { captureAuthProfileCredentialAuthority } from "../../state/user-model-account-authority.js";
import { listAgentEntries, resolveAgentDir } from "../agent-scope.js";
import { AUTH_STORE_VERSION } from "./constants.js";
import { isSameOAuthRefreshGeneration } from "./oauth-refresh-marker.js";
import { mergePersistedAuthProfileState } from "./persisted.js";
import { getWorkerAuthProfileWrites } from "./runtime-scope.js";
import {
  loadPersistedAuthProfileStoreFromRows,
  prepareAgentAuthProfileRowsRead,
} from "./sqlite-read.js";
import {
  inspectPersistedAuthProfileStoreRaw,
  readPersistedAuthProfileStateRaw,
  resolveAuthProfileDatabasePath,
  runAuthProfileWriteTransaction,
} from "./sqlite.js";
import { coerceAuthProfileState } from "./state.js";
import { saveAuthProfileStoreWithPreparedOwner } from "./store-runtime.js";
import type { SaveAuthProfileStoreOptions } from "./store-save.js";
import { AuthProfileStoreUnreadableError } from "./store-unreadable-error.js";
import {
  createAuthProfileStoreUpdatePublisher,
  runAuthProfileStoreUpdate,
} from "./store-update.js";
import type { AuthStoreUpdateInput } from "./store.worker-contract.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";
import { runAuthProfileUsage } from "./usage-lifecycle.js";

export type CandidateAuthProfileStore = {
  agentId: string;
  agentDir: string;
  databasePath: string;
  databaseIdentity: DatabasePathIdentity;
  configured: boolean;
  env: NodeJS.ProcessEnv;
};

type CandidateSource = {
  agentId: string;
  agentDir?: string;
  databasePath: string;
  configured: boolean;
};

function canonicalizeDatabasePath(databasePath: string): string {
  return resolvePathViaExistingAncestorSync(path.resolve(databasePath));
}

async function collectStateRootCandidates(env: NodeJS.ProcessEnv): Promise<CandidateSource[]> {
  const agentsRoot = path.join(resolveStateDir(env), "agents");
  let entries: Dirent[];
  try {
    entries = await fs.readdir(agentsRoot, { withFileTypes: true });
  } catch (error) {
    if (isErrno(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => {
      const agentId = normalizeAgentId(entry.name);
      const agentDir = path.join(agentsRoot, entry.name, "agent");
      return {
        agentId,
        agentDir,
        databasePath: resolveAuthProfileDatabasePath(agentDir),
        configured: false,
      };
    });
}

/**
 * Discover every auth-capable agent database once by canonical filesystem
 * identity. Registered paths cover custom database locations that cannot be
 * reconstructed from an agent directory.
 */
export async function listCandidateAuthProfileStores(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<CandidateAuthProfileStore[]> {
  const env = cloneEnvWithPlatformSemantics(params.env ?? process.env);
  const sources: CandidateSource[] = [];
  for (const entry of listAgentEntries(params.cfg)) {
    const id = entry.id?.trim();
    if (!id) {
      continue;
    }
    const agentId = normalizeAgentId(id);
    const agentDir = path.resolve(resolveAgentDir(params.cfg, agentId, env));
    sources.push({
      agentId,
      agentDir,
      databasePath: resolveAuthProfileDatabasePath(agentDir),
      configured: true,
    });
  }
  sources.push(...(await collectStateRootCandidates(env)));
  for (const registered of await listOpenClawRegisteredAgentDatabasesAsync({ env })) {
    const agentId = normalizeAgentId(registered.agentId);
    sources.push({
      agentId,
      databasePath: registered.path,
      configured: false,
    });
  }

  const candidates = new Map<string, CandidateAuthProfileStore>();
  for (const source of sources) {
    const databasePath = canonicalizeDatabasePath(source.databasePath);
    const agentDir = source.agentDir ?? path.dirname(databasePath);
    const existing = candidates.get(databasePath);
    if (!existing) {
      candidates.set(databasePath, {
        agentId: source.agentId,
        agentDir,
        databasePath,
        databaseIdentity: readDatabasePathIdentitySync(databasePath),
        configured: source.configured,
        env,
      });
    } else if (source.configured) {
      existing.configured = true;
    }
  }
  return [...candidates.values()].toSorted((left, right) =>
    left.databasePath.localeCompare(right.databasePath),
  );
}

function assertCandidateDatabaseIdentity(candidate: CandidateAuthProfileStore): void {
  if (candidate.databaseIdentity.key.startsWith("path:")) {
    // Discovery captured no file; startup or another operation may create it before first use.
    candidate.databaseIdentity = readDatabasePathIdentitySync(candidate.databasePath);
  } else {
    assertDatabasePathIdentity(candidate.databasePath, candidate.databaseIdentity);
  }
}

/** Read the captured physical candidate through the existing auth reader. */
export async function loadCandidateAuthProfileStoreAsync(
  candidate: CandidateAuthProfileStore,
): Promise<AuthProfileStore | null> {
  assertCandidateDatabaseIdentity(candidate);
  const reader = prepareAgentAuthProfileRowsRead(candidate);
  try {
    const rows = await reader.read();
    reader.assertCurrent();
    assertCandidateDatabaseIdentity(candidate);
    return loadPersistedAuthProfileStoreFromRows(rows, candidate.databasePath);
  } finally {
    await reader.dispose();
  }
}

/** Keep the owner's current credential facts available at a later write boundary. */
export async function prepareCandidateAuthProfileCredentialRead(
  candidate: CandidateAuthProfileStore,
  profileId: string,
): Promise<
  Pick<
    ReturnType<typeof captureAuthProfileCredentialAuthority>,
    "readCurrentCredential" | "waitUntilCurrent"
  >
> {
  // Key the authority by the adopted file identity that later writes publish under.
  assertCandidateDatabaseIdentity(candidate);
  const authority = captureAuthProfileCredentialAuthority(
    captureOpenClawStateWorkerContext({ env: candidate.env }),
    {
      identity: `${candidate.databaseIdentity.key}:${candidate.databaseIdentity.birthtime ?? ""}`,
      databasePath: candidate.databasePath,
    },
    profileId,
  );
  const store = await loadCandidateAuthProfileStoreAsync(candidate);
  authority.observe(store?.profiles[profileId]);
  await authority.waitUntilCurrent();
  return authority;
}

type CandidateAuthProfileUpdate = {
  assertCurrent?: () => void;
  candidate: CandidateAuthProfileStore;
  preserveProfileState?: boolean;
  profileId: string;
  updater: (store: AuthProfileStore) => boolean;
};

/** Skip unrelated generations before write admission; possible matches still use the writer. */
export async function fenceCandidateAuthProfileStore(
  params: CandidateAuthProfileUpdate & { generation: OAuthCredential },
): Promise<void> {
  const store = await loadCandidateAuthProfileStoreAsync(params.candidate);
  const credential = store?.profiles[params.profileId];
  if (
    credential?.type !== "oauth" ||
    !isSameOAuthRefreshGeneration({
      profileId: params.profileId,
      left: credential,
      right: params.generation,
    })
  ) {
    return;
  }
  await runCandidateAuthProfileUpdate(params, {
    profileId: params.profileId,
    generation: params.generation,
  });
}

/** The existing auth writer compares and updates one exact candidate under its lock. */
export async function updateCandidateAuthProfileStore(
  params: CandidateAuthProfileUpdate,
): Promise<{ changed: boolean; store: AuthProfileStore }> {
  const result = await runCandidateAuthProfileUpdate(params);
  if (!result) {
    throw new Error("Auth candidate update completed without its requested rows");
  }
  return result;
}

async function runCandidateAuthProfileUpdate(
  params: CandidateAuthProfileUpdate,
  peerGeneration?: AuthStoreUpdateInput["peerGeneration"],
): Promise<{ changed: boolean; store: AuthProfileStore } | undefined> {
  const { candidate } = params;
  const saveOptions = {
    filterExternalAuthProfiles: false,
    syncExternalCli: false,
    ...(params.preserveProfileState
      ? {
          preserveOrderProfileIds: [params.profileId],
          preserveStateProfileIds: [params.profileId],
        }
      : {}),
  } satisfies SaveAuthProfileStoreOptions;
  const workerWrites = getWorkerAuthProfileWrites();
  if (workerWrites) {
    const assertCurrent = () => {
      workerWrites.assertOwner(candidate.env);
      assertCandidateDatabaseIdentity(candidate);
      params.assertCurrent?.();
    };
    return runAuthProfileUsage(() =>
      workerWrites.run(() => {
        assertCurrent();
        return runAuthProfileWriteTransaction(
          candidate.agentDir,
          (database, owner) => {
            assertCurrent();
            const cell = inspectPersistedAuthProfileStoreRaw(candidate.agentDir, database);
            if (cell.status === "unreadable") {
              throw new AuthProfileStoreUnreadableError(candidate.databasePath);
            }
            const state = readPersistedAuthProfileStateRaw(candidate.agentDir, database);
            const loaded =
              cell.status === "readable"
                ? mergePersistedAuthProfileState(cell.raw, () => state)
                : null;
            if (cell.status === "readable" && !loaded) {
              throw new AuthProfileStoreUnreadableError(candidate.databasePath);
            }
            const store = loaded ?? {
              version: AUTH_STORE_VERSION,
              profiles: {},
              ...coerceAuthProfileState(state),
            };
            if (peerGeneration) {
              const credential = store.profiles[peerGeneration.profileId];
              if (
                credential?.type !== "oauth" ||
                !isSameOAuthRefreshGeneration({
                  profileId: peerGeneration.profileId,
                  left: credential,
                  right: peerGeneration.generation,
                })
              ) {
                return undefined;
              }
            }
            const changed = params.updater(store);
            assertCurrent();
            if (changed) {
              saveAuthProfileStoreWithPreparedOwner(
                store,
                candidate.agentDir,
                saveOptions,
                database,
                owner,
              );
            }
            return { changed, store };
          },
          {
            existingDatabaseTarget: {
              kind: "agent",
              agentId: candidate.agentId,
              path: candidate.databasePath,
              env: candidate.env,
              identity: candidate.databaseIdentity,
              assertCurrent,
            },
          },
        );
      }),
    );
  }
  let result: { changed: boolean; store: AuthProfileStore } | undefined;
  await runAuthProfileStoreUpdate({
    agentDir: candidate.agentDir,
    existingDatabaseTarget: {
      kind: "agent",
      agentId: candidate.agentId,
      path: candidate.databasePath,
      env: candidate.env,
    },
    envOnly: false,
    peerGeneration,
    options: { env: candidate.env },
    assertCurrent: () => {
      assertCandidateDatabaseIdentity(candidate);
      params.assertCurrent?.();
    },
    update(prepared) {
      const store = prepared.store;
      const changed = params.updater(store);
      result = { changed, store };
      return changed
        ? {
            save: true,
            store,
            externalProfiles: [],
            options: saveOptions,
          }
        : { save: false };
    },
    publish: createAuthProfileStoreUpdatePublisher(
      "Auth candidate committed before publication failed",
    ),
  });
  return result;
}
