/** Locked auth profile writes and attempt-scoped compensation. */
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { replaceAuthProfileAuthorization } from "./authorization-lifetime.js";
import { normalizeAuthProfileCredential } from "./credential-normalize.js";
import { withOAuthProfileLock, withOAuthProfileLocks } from "./oauth-profile-lock.js";
import { isOAuthRefreshFence, isSameOAuthRefreshGeneration } from "./oauth-refresh-marker.js";
import { prepareSharedAuthStoreOwnership, resolveSharedAuthStorePath } from "./path-resolve.js";
import { mergePersistedAuthProfileState } from "./persisted.js";
import { resolveSharedMainAuthAgentDir } from "./shared-main-dir.js";
import { isSharedAuthProfileWrite } from "./shared-store-bootstrap.js";
import { prepareAgentAuthProfileRowsRead, readSharedAuthProfileRows } from "./sqlite-read.js";
import {
  prepareAuthProfileWriteEnvironment,
  resolveAuthProfileDatabasePath,
  resolveAuthProfileDatabaseOwnerId,
} from "./sqlite.js";
import {
  findPersistedAuthProfileCredentialAsync,
  updateAuthProfileStoreWithLock,
} from "./store-runtime.js";
import { watchAuthProfileNativeCommits } from "./store-update-commit.js";
import { publishAuthProfileStoreUpdate } from "./store-update-publication.js";
import { runAuthProfileStoreUpdate } from "./store-update.js";
import { getScopedAuthProfileEnv, resolveRuntimeAuthProfileAgentDir } from "./store.js";
import type {
  AuthProfileCredential,
  AuthProfileStore,
  OAuthCredential,
  PreparedAuthProfileStoreOwner,
} from "./types.js";
import { reserveAuthProfileUsagePreparation } from "./usage-lifecycle.js";
import { resetAuthProfileFailureState } from "./usage-state.js";

function resolveAuthProfileWriteEnv(params: { stateDir?: string }): NodeJS.ProcessEnv {
  return params.stateDir
    ? { ...process.env, OPENCLAW_STATE_DIR: params.stateDir }
    : (getScopedAuthProfileEnv() ?? process.env);
}

/** `agentDir` is the directory the write passes to the store updater, as that writer resolves it. */
async function loadAuthProfileWriteAuthorities(
  params: { agentDir?: string; stateDir?: string },
  profileIds: readonly string[],
): Promise<ReadonlyMap<string, AuthProfileCredential | undefined>> {
  if (profileIds.length === 0) {
    return new Map();
  }
  // Select the owner the store update selects: its write env, then shared vs agent target.
  const env = prepareAuthProfileWriteEnvironment({
    stateDir: params.stateDir,
    env: params.stateDir ? undefined : getScopedAuthProfileEnv(),
  });
  const agentDir = isSharedAuthProfileWrite({
    agentDir: params.agentDir,
    allowExplicitMain: true,
    env,
  })
    ? undefined
    : params.agentDir;
  // The inherited-credential fallback without stateDir reads the runtime-resolved directory.
  const readDirs = !agentDir
    ? []
    : params.stateDir
      ? [agentDir]
      : [agentDir, resolveRuntimeAuthProfileAgentDir(agentDir) ?? agentDir];
  // Include both possible shared owners before cold ownership discovery can yield.
  const paths = [
    ...new Set([
      resolveOpenClawStateSqlitePath(env),
      resolveAuthProfileDatabasePath(resolveSharedMainAuthAgentDir(env)),
      ...readDirs.map((dir) => resolveAuthProfileDatabasePath(dir)),
    ]),
  ];
  const reservation = reserveAuthProfileUsagePreparation(paths);
  const watches = paths.map((databasePath) => {
    const watch = watchAuthProfileNativeCommits(databasePath);
    return { dispose: () => watch.dispose(), unchanged: watch.capture() };
  });
  try {
    await reservation.ready;
    await prepareSharedAuthStoreOwnership(env);
    const readStore = async (dir?: string) => {
      const databasePath = dir
        ? resolveAuthProfileDatabasePath(dir)
        : resolveSharedAuthStorePath(env);
      const reader =
        !dir && databasePath === resolveOpenClawStateSqlitePath(env)
          ? undefined
          : prepareAgentAuthProfileRowsRead({
              databasePath,
              agentId: resolveAuthProfileDatabaseOwnerId(path.dirname(databasePath)),
              env,
            });
      try {
        const rows = reader
          ? await reader.read()
          : await readSharedAuthProfileRows(captureOpenClawStateWorkerContext({ env }));
        return mergePersistedAuthProfileState(
          rows.store.status === "readable" ? rows.store.raw : null,
          () => (rows.state.status === "readable" ? rows.state.raw : null),
        );
      } finally {
        await reader?.dispose();
      }
    };
    const target = await readStore(agentDir);
    const observed = new Map(profileIds.map((id) => [id, target?.profiles[id]]));
    const missingIds = profileIds.filter((id) => !observed.get(id));
    if (agentDir && missingIds.length > 0) {
      if (params.stateDir) {
        const shared = await readStore();
        for (const id of missingIds) {
          observed.set(id, shared?.profiles[id]);
        }
      } else {
        for (const profileId of missingIds) {
          observed.set(
            profileId,
            await findPersistedAuthProfileCredentialAsync({
              agentDir,
              profileId,
            }),
          );
        }
      }
    }
    // A rare concurrent legacy sync commit makes admission unknown: refuse conservatively, retryably.
    return watches.every((watch) => watch.unchanged()) ? observed : new Map();
  } finally {
    for (const watch of watches) {
      watch.dispose();
    }
    reservation.release();
  }
}

function needsOAuthRefreshAuthority(
  credential: AuthProfileCredential,
): credential is OAuthCredential {
  return (
    credential.type === "oauth" &&
    credential.copyToAgents !== true &&
    !isOAuthRefreshFence(credential)
  );
}

function rejectsOAuthRefreshGenerationReplacement(params: {
  profileId: string;
  observed: AuthProfileCredential | undefined;
  current: AuthProfileCredential | undefined;
  local: AuthProfileCredential | undefined;
  incoming: AuthProfileCredential;
  allowOAuthGenerationReplacement: boolean;
}): boolean {
  if (!needsOAuthRefreshAuthority(params.incoming)) {
    return false;
  }
  let supersedes: boolean;
  if (isDeepStrictEqual(params.current, params.observed)) {
    supersedes =
      !params.allowOAuthGenerationReplacement &&
      params.current !== undefined &&
      !(params.current.type === "oauth" && isOAuthRefreshFence(params.current)) &&
      (params.current.type !== "oauth" ||
        !isSameOAuthRefreshGeneration({
          profileId: params.profileId,
          left: params.current,
          right: params.incoming,
        }));
  } else if (params.observed === undefined) {
    supersedes = params.current !== undefined;
  } else {
    supersedes =
      !params.allowOAuthGenerationReplacement ||
      params.observed.type !== "oauth" ||
      isSameOAuthRefreshGeneration({
        profileId: params.profileId,
        left: params.observed,
        right: params.incoming,
      });
  }
  return (
    supersedes ||
    (params.local?.type === "oauth" &&
      isOAuthRefreshFence(params.local) &&
      isSameOAuthRefreshGeneration({
        profileId: params.profileId,
        left: params.local,
        right: params.incoming,
      }))
  );
}

type PersistAuthProfileBatchParams = {
  /** Revalidate the calling operation after lock acquisition, at the write boundary. */
  beforeWrite?: () => void;
  /** Revalidate a targeted profile identity under the same transaction as the write. */
  validateCurrentCredential?: (
    profileId: string,
    credential: AuthProfileCredential | undefined,
  ) => void;
  profiles: readonly {
    profileId: string;
    credential: AuthProfileCredential;
    replaceExisting?: boolean;
  }[];
  order?: Readonly<Record<string, readonly string[]>>;
  agentDir?: string;
  stateDir?: string;
  resetFailureState?: boolean;
  allowOAuthGenerationReplacement?: boolean;
};

type AuthProfileBatchRollbackResult = {
  unrevertedProfileIds: ReadonlySet<string>;
};

/** Atomically persists a batch and returns conditional attempt-scoped compensation. */
export async function persistAuthProfileBatch(
  params: PersistAuthProfileBatchParams,
): Promise<{ rollback: () => Promise<AuthProfileBatchRollbackResult> }> {
  const profiles = new Map(
    params.profiles.map(({ profileId, credential, replaceExisting }) => [
      profileId,
      {
        credential: normalizeAuthProfileCredential(credential),
        replaceExisting: replaceExisting !== false,
      },
    ]),
  );
  if (profiles.size === 0) {
    const result = { unrevertedProfileIds: new Set<string>() };
    return { rollback: async () => result };
  }
  const authorityProfileIds = [...profiles.entries()]
    .filter(([, entry]) => needsOAuthRefreshAuthority(entry.credential))
    .map(([profileId]) => profileId);
  // Capture before the lock wait so a queued batch cannot restore a consumed OAuth generation.
  const observedProfiles =
    authorityProfileIds.length > 0
      ? await loadAuthProfileWriteAuthorities(params, authorityProfileIds)
      : new Map<string, AuthProfileCredential | undefined>();

  return await withOAuthProfileLocks(
    [...profiles.entries()].flatMap(([profileId, entry]) =>
      entry.credential.type === "oauth" ? [{ profileId, provider: entry.credential.provider }] : [],
    ),
    async () => {
      const previousProfiles = new Map<string, AuthProfileCredential | undefined>();
      const previousOrder = new Map<string, readonly string[] | undefined>();
      const appliedProfiles = new Map<string, AuthProfileCredential>();
      let storeWasAbsent = false;
      let preparedOwner: PreparedAuthProfileStoreOwner | undefined;
      await runAuthProfileStoreUpdate({
        agentDir: params.agentDir,
        envOnly: false,
        options: {
          sharedStoreWrite: true,
          stateDir: params.stateDir,
          env: params.stateDir ? undefined : getScopedAuthProfileEnv(),
        },
        update(prepared) {
          params.beforeWrite?.();
          storeWasAbsent = !prepared.storePresent;
          const next = prepared.store;
          for (const [profileId, entry] of profiles) {
            params.validateCurrentCredential?.(profileId, next.profiles[profileId]);
            if (!entry.replaceExisting && Object.hasOwn(next.profiles, profileId)) {
              continue;
            }
            if (
              rejectsOAuthRefreshGenerationReplacement({
                profileId,
                observed: observedProfiles.get(profileId),
                current: next.profiles[profileId] ?? prepared.mainStore?.profiles[profileId],
                local: next.profiles[profileId],
                incoming: entry.credential,
                allowOAuthGenerationReplacement: params.allowOAuthGenerationReplacement === true,
              })
            ) {
              throw new Error(
                `Refused to restore fenced OAuth refresh generation for profile "${profileId}".`,
              );
            }
            previousProfiles.set(profileId, next.profiles[profileId]);
            next.profiles[profileId] = replaceAuthProfileAuthorization(entry.credential);
            const existingStats = next.usageStats?.[profileId];
            if (params.resetFailureState && existingStats) {
              next.usageStats![profileId] = resetAuthProfileFailureState(existingStats);
            }
            appliedProfiles.set(profileId, entry.credential);
          }
          for (const [provider, profileIds] of Object.entries(params.order ?? {})) {
            previousOrder.set(provider, next.order?.[provider]);
            const existing = next.order?.[provider] ?? [];
            const additions = [...new Set(profileIds)].filter(
              (profileId) => appliedProfiles.has(profileId) && !existing.includes(profileId),
            );
            if (additions.length > 0) {
              next.order = { ...next.order, [provider]: [...existing, ...additions] };
            }
          }
          if (appliedProfiles.size === 0) {
            return { save: false };
          }
          return {
            save: true,
            store: next,
            externalProfiles: [],
            options: { filterExternalAuthProfiles: false, syncExternalCli: false },
          };
        },
        async publish(committed, owner, assertCurrent, nativeCommits, committedIsCurrent) {
          preparedOwner = owner;
          if (committed) {
            await publishAuthProfileStoreUpdate(
              owner,
              committed,
              assertCurrent,
              nativeCommits,
              committedIsCurrent,
            );
          }
        },
      });

      let rollbackResult: Promise<AuthProfileBatchRollbackResult> | undefined;
      return {
        rollback: async () => {
          if (rollbackResult) {
            return rollbackResult;
          }
          if (appliedProfiles.size === 0) {
            return { unrevertedProfileIds: new Set<string>() };
          }
          rollbackResult = (async () => {
            const unrevertedProfileIds = new Set<string>();
            await runAuthProfileStoreUpdate({
              agentDir: params.agentDir,
              envOnly: false,
              options: { sharedStoreWrite: true, env: preparedOwner?.env },
              update(prepared, owner) {
                if (owner.databasePath !== preparedOwner?.databasePath) {
                  throw new Error("auth profile batch rollback belongs to another owner");
                }
                if (!prepared.storePresent) {
                  return { save: false };
                }
                const current = prepared.store;
                const ownedProfiles = new Set<string>();
                for (const [profileId, credential] of appliedProfiles) {
                  if (!isDeepStrictEqual(current.profiles[profileId], credential)) {
                    unrevertedProfileIds.add(profileId);
                    continue;
                  }
                  const previous = previousProfiles.get(profileId);
                  // Nonportable OAuth generations can be consumed after this batch
                  // commits. A delayed rollback must never make one replayable.
                  if (previous?.type === "oauth" && previous.copyToAgents !== true) {
                    unrevertedProfileIds.add(profileId);
                    continue;
                  }
                  ownedProfiles.add(profileId);
                  if (previous) {
                    current.profiles[profileId] = previous;
                  } else {
                    delete current.profiles[profileId];
                  }
                }
                for (const [provider, profileIds] of Object.entries(params.order ?? {})) {
                  const existing = current.order?.[provider];
                  if (!existing) {
                    continue;
                  }
                  const preexisting = new Set(previousOrder.get(provider) ?? []);
                  const introduced = new Set(
                    profileIds.filter((profileId) => !preexisting.has(profileId)),
                  );
                  const remaining = existing.filter(
                    (profileId) => !introduced.has(profileId) || !ownedProfiles.has(profileId),
                  );
                  if (remaining.length === existing.length) {
                    continue;
                  }
                  if (remaining.length > 0) {
                    current.order = { ...current.order, [provider]: remaining };
                  } else if (current.order) {
                    delete current.order[provider];
                    if (Object.keys(current.order).length === 0) {
                      delete current.order;
                    }
                  }
                }
                return {
                  save: true,
                  store: current,
                  deleteEmptyStore: storeWasAbsent,
                  externalProfiles: [],
                  options: { filterExternalAuthProfiles: false, syncExternalCli: false },
                };
              },
              async publish(committed, owner, assertCurrent, nativeCommits, committedIsCurrent) {
                if (committed) {
                  await publishAuthProfileStoreUpdate(
                    owner,
                    committed,
                    assertCurrent,
                    nativeCommits,
                    committedIsCurrent,
                  );
                }
              },
            });
            return { unrevertedProfileIds };
          })().catch((error: unknown) => {
            rollbackResult = undefined;
            throw error;
          });
          return rollbackResult;
        },
      };
    },
    { env: resolveAuthProfileWriteEnv(params) },
  );
}

type AuthProfileUpsertParams = {
  profileId: string;
  validateCurrentCredential?: (credential: AuthProfileCredential | undefined) => void;
  assertCurrent?: () => void;
  preserveApiKeyMetadata?: boolean;
  resetFailureState?: boolean;
  credential: AuthProfileCredential;
  agentDir?: string;
  stateDir?: string;
};

/** Upserts an auth profile under the store lock, returning null on store write failure. */
export async function upsertAuthProfileWithLock(
  params: AuthProfileUpsertParams,
): Promise<AuthProfileStore | null> {
  const credential = normalizeAuthProfileCredential(params.credential);
  const observed = needsOAuthRefreshAuthority(credential)
    ? (
        await loadAuthProfileWriteAuthorities(
          { ...params, agentDir: resolveRuntimeAuthProfileAgentDir(params.agentDir) },
          [params.profileId],
        )
      ).get(params.profileId)
    : undefined;
  let rejectedFencedGeneration = false;
  const update = async () => {
    return await updateAuthProfileStoreWithLock({
      agentDir: params.agentDir,
      sharedStoreWrite: true,
      stateDir: params.stateDir,
      assertCurrent: params.assertCurrent,
      saveOptions: {
        filterExternalAuthProfiles: false,
        syncExternalCli: false,
      },
      updater: (store, owner, sharedStore) => {
        const currentAuthority =
          store.profiles[params.profileId] ??
          (owner && owner.databasePath !== owner.sharedDatabasePath
            ? sharedStore?.profiles[params.profileId]
            : undefined);
        // Consumers can reject a changed profile kind under the same lock as the write.
        params.validateCurrentCredential?.(store.profiles[params.profileId]);
        if (
          rejectsOAuthRefreshGenerationReplacement({
            profileId: params.profileId,
            observed,
            current: currentAuthority,
            local: store.profiles[params.profileId],
            incoming: credential,
            allowOAuthGenerationReplacement: false,
          })
        ) {
          rejectedFencedGeneration = true;
          return false;
        }
        const existing = store.profiles[params.profileId];
        if (
          params.preserveApiKeyMetadata &&
          existing?.type === "api_key" &&
          credential.type === "api_key" &&
          normalizeProviderId(existing.provider) === normalizeProviderId(credential.provider)
        ) {
          const { key: _key, keyRef: _keyRef, ...metadata } = existing;
          store.profiles[params.profileId] = replaceAuthProfileAuthorization({
            ...metadata,
            ...credential,
          });
        } else {
          store.profiles[params.profileId] = replaceAuthProfileAuthorization(credential);
        }
        const existingStats = store.usageStats?.[params.profileId];
        if (params.resetFailureState && store.usageStats && existingStats) {
          store.usageStats[params.profileId] = resetAuthProfileFailureState(existingStats);
        }
        return true;
      },
    });
  };
  const updated =
    credential.type === "oauth"
      ? await withOAuthProfileLock(
          { profileId: params.profileId, provider: credential.provider },
          update,
          { env: resolveAuthProfileWriteEnv(params) },
        )
      : await update();
  return rejectedFencedGeneration ? null : updated;
}

/** Upserts an auth profile under the store lock, failing when the store cannot be written. */
export async function upsertAuthProfileWithLockOrThrow(
  params: Parameters<typeof upsertAuthProfileWithLock>[0],
): Promise<void> {
  const updated = await upsertAuthProfileWithLock(params);
  if (!updated) {
    throw new Error(
      "Failed to update auth profile store; the auth store lock may be busy. Wait a moment and retry.",
    );
  }
}
