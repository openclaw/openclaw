import { formatErrorMessage } from "../../infra/errors.js";
import { withFileLock } from "../../infra/file-lock.js";
import {
  AUTH_STORE_LOCK_OPTIONS,
  OAUTH_REFRESH_CALL_TIMEOUT_MS,
  OAUTH_REFRESH_LOCK_OPTIONS,
  log,
} from "./constants.js";
import { shouldMirrorRefreshedOAuthCredential } from "./oauth-identity.js";
import {
  buildRefreshContentionError,
  isGlobalRefreshLockTimeoutError,
} from "./oauth-refresh-lock-errors.js";
import {
  areOAuthCredentialsEquivalent,
  hasOAuthIdentity,
  hasUsableOAuthCredential,
  isSafeToAdoptBootstrapOAuthIdentity,
  isSafeToAdoptMainStoreOAuthIdentity,
  isSafeToOverwriteStoredOAuthIdentity,
  overlayRuntimeExternalOAuthProfiles,
  shouldBootstrapFromExternalCliCredential,
  shouldPersistRuntimeExternalOAuthProfile,
  shouldReplaceStoredOAuthCredential,
  type RuntimeExternalOAuthProfile,
} from "./oauth-shared.js";
import { ensureAuthStoreFile, resolveAuthStorePath, resolveOAuthRefreshLockPath } from "./paths.js";
import {
  ensureAuthProfileStore,
  loadAuthProfileStoreForSecretsRuntime,
  saveAuthProfileStore,
  resolvePersistedAuthProfileOwnerAgentDir,
  updateAuthProfileStoreWithLock,
} from "./store.js";
import type { AuthProfileStore, OAuthCredential, OAuthCredentials } from "./types.js";

export type OAuthManagerAdapter = {
  buildApiKey: (provider: string, credentials: OAuthCredential) => Promise<string>;
  refreshCredential: (credential: OAuthCredential) => Promise<OAuthCredentials | null>;
  readBootstrapCredential: (params: {
    profileId: string;
    credential: OAuthCredential;
  }) => OAuthCredential | null;
  isRefreshTokenReusedError: (error: unknown) => boolean;
};

export type ResolvedOAuthAccess = {
  apiKey: string;
  credential: OAuthCredential;
};

export class OAuthManagerRefreshError extends Error {
  readonly profileId: string;
  readonly provider: string;
  readonly code?: string;
  readonly lockPath?: string;
  readonly #refreshedStore: AuthProfileStore;
  readonly #credential: OAuthCredential;

  constructor(params: {
    credential: OAuthCredential;
    profileId: string;
    refreshedStore: AuthProfileStore;
    cause: unknown;
  }) {
    const structuredCause =
      typeof params.cause === "object" && params.cause !== null
        ? (params.cause as { code?: unknown; lockPath?: unknown; cause?: unknown })
        : undefined;
    const delegatedCause =
      structuredCause?.code === "refresh_contention" && structuredCause.cause
        ? structuredCause.cause
        : params.cause;
    super(
      `OAuth token refresh failed for ${params.credential.provider}: ${formatErrorMessage(params.cause)}`,
      { cause: delegatedCause },
    );
    this.name = "OAuthManagerRefreshError";
    this.#credential = params.credential;
    this.profileId = params.profileId;
    this.provider = params.credential.provider;
    this.#refreshedStore = params.refreshedStore;
    if (structuredCause) {
      this.code = typeof structuredCause.code === "string" ? structuredCause.code : undefined;
      if (typeof structuredCause.lockPath === "string") {
        this.lockPath = structuredCause.lockPath;
      } else if (
        typeof structuredCause.cause === "object" &&
        structuredCause.cause !== null &&
        "lockPath" in structuredCause.cause &&
        typeof structuredCause.cause.lockPath === "string"
      ) {
        this.lockPath = structuredCause.cause.lockPath;
      }
    }
  }

  getRefreshedStore(): AuthProfileStore {
    return this.#refreshedStore;
  }

  getCredential(): OAuthCredential {
    return this.#credential;
  }

  toJSON(): { name: string; message: string; profileId: string; provider: string } {
    return {
      name: this.name,
      message: this.message,
      profileId: this.profileId,
      provider: this.provider,
    };
  }
}

export {
  areOAuthCredentialsEquivalent,
  hasUsableOAuthCredential,
  isSafeToAdoptBootstrapOAuthIdentity,
  isSafeToAdoptMainStoreOAuthIdentity,
  isSafeToOverwriteStoredOAuthIdentity,
  overlayRuntimeExternalOAuthProfiles,
  shouldBootstrapFromExternalCliCredential,
  shouldPersistRuntimeExternalOAuthProfile,
  shouldReplaceStoredOAuthCredential,
};
export type { RuntimeExternalOAuthProfile };

function hasOAuthCredentialChanged(
  previous: Pick<OAuthCredential, "access" | "refresh" | "expires">,
  current: Pick<OAuthCredential, "access" | "refresh" | "expires">,
): boolean {
  return (
    previous.access !== current.access ||
    previous.refresh !== current.refresh ||
    previous.expires !== current.expires
  );
}

async function loadFreshStoredOAuthCredential(params: {
  profileId: string;
  agentDir?: string;
  provider: string;
  previous?: Pick<OAuthCredential, "access" | "refresh" | "expires">;
  requireChange?: boolean;
}): Promise<OAuthCredential | null> {
  const reloadedStore = loadAuthProfileStoreForSecretsRuntime(params.agentDir);
  const reloaded = reloadedStore.profiles[params.profileId];
  if (
    reloaded?.type !== "oauth" ||
    reloaded.provider !== params.provider ||
    !hasUsableOAuthCredential(reloaded)
  ) {
    return null;
  }
  if (
    params.requireChange &&
    params.previous &&
    !hasOAuthCredentialChanged(params.previous, reloaded)
  ) {
    return null;
  }
  return reloaded;
}

export function resolveEffectiveOAuthCredential(params: {
  profileId: string;
  credential: OAuthCredential;
  readBootstrapCredential: OAuthManagerAdapter["readBootstrapCredential"];
}): OAuthCredential {
  const imported = params.readBootstrapCredential({
    profileId: params.profileId,
    credential: params.credential,
  });
  if (!imported) {
    return params.credential;
  }
  if (hasUsableOAuthCredential(params.credential)) {
    log.debug("resolved oauth credential from canonical local store", {
      profileId: params.profileId,
      provider: params.credential.provider,
      localExpires: params.credential.expires,
      externalExpires: imported.expires,
    });
    return params.credential;
  }
  if (!isSafeToAdoptBootstrapOAuthIdentity(params.credential, imported)) {
    log.warn("refused external oauth bootstrap credential: identity mismatch or missing binding", {
      profileId: params.profileId,
      provider: params.credential.provider,
    });
    return params.credential;
  }
  const shouldBootstrap = shouldBootstrapFromExternalCliCredential({
    existing: params.credential,
    imported,
  });
  if (shouldBootstrap) {
    log.debug("resolved oauth credential from external cli bootstrap", {
      profileId: params.profileId,
      provider: imported.provider,
      localExpires: params.credential.expires,
      externalExpires: imported.expires,
    });
    return imported;
  }
  return params.credential;
}

export function createOAuthManager(adapter: OAuthManagerAdapter) {
  // In-process cache of the most recent successful refresh per
  // (provider, profileId). The cross-agent file lock and the in-process
  // refresh queue serialize refresh callers so that only one peer hits the
  // provider per (provider, profileId), but the recovery for queued peers
  // historically relied on the leader's mirror-to-main write being visible
  // on disk. That mirror is best-effort: the silent catch in
  // `mirrorRefreshedCredentialIntoMainStore`, transient
  // `withFileLock` timeouts on Windows when antivirus or another tool is
  // briefly holding the main auth-profiles.json, and external rollbacks of
  // the file (e.g. `openclaw doctor` writing back a doctor-cached store)
  // can all leave main on disk holding the pre-rotation credential while
  // the leader's refresh succeeded. Without this cache, a queued peer
  // would then re-enter the refresh path with its own already-rotated
  // refresh_token and produce the `refresh_token_reused` 401 reported in
  // issue #74055. The cache is the authoritative in-process record of "a
  // peer of mine just refreshed this profile and got these credentials" —
  // every adoption checkpoint consults it before deciding to refresh.
  const recentlyRefreshedCredentials = new Map<string, OAuthCredential>();

  function refreshQueueKey(provider: string, profileId: string): string {
    return `${provider}\u0000${profileId}`;
  }

  function rememberRefreshedCredential(
    provider: string,
    profileId: string,
    credential: OAuthCredential,
  ): void {
    // Bound process-lifetime growth without adding LRU/TTL machinery: any
    // entry whose access token is no longer usable can never satisfy
    // `findInProcessRefreshedCredential`, so drop those siblings whenever
    // we publish a new one. Stable in N=1 swarms (the common case) and O(N)
    // in N≫1 churn scenarios where N is the number of distinct profiles
    // that have rotated during this process's lifetime.
    for (const [key, entry] of recentlyRefreshedCredentials) {
      if (!hasUsableOAuthCredential(entry)) {
        recentlyRefreshedCredentials.delete(key);
      }
    }
    recentlyRefreshedCredentials.set(refreshQueueKey(provider, profileId), credential);
  }

  /**
   * Look up the most recent in-process refresh result for `(provider,
   * profileId)` that is still usable and identity-safe to adopt.
   *
   * Callers always pass a real `OAuthCredential` for `requesting` (it
   * originates from a store load that already gated on `cred.type ===
   * "oauth"`), so the `existing === undefined` branch inside
   * `isSafeToAdoptMainStoreOAuthIdentity` is unreachable here. That helper
   * is shared with the disk-backed main-store adoption path, where
   * `existing` can legitimately be undefined; we deliberately reuse the
   * same identity policy so the cache and disk paths cannot disagree on
   * what counts as "same account".
   */
  function findInProcessRefreshedCredential(
    provider: string,
    profileId: string,
    requesting: OAuthCredential,
  ): OAuthCredential | null {
    const cached = recentlyRefreshedCredentials.get(refreshQueueKey(provider, profileId));
    if (
      !cached ||
      cached.type !== "oauth" ||
      cached.provider !== requesting.provider ||
      !hasUsableOAuthCredential(cached)
    ) {
      return null;
    }
    // Strict identity match. The disk-side adoption path is intentionally
    // lenient — a local store that lost its identity (e.g., after a Codex
    // refresh that drops accountId) is allowed to inherit identity from
    // main on first contact. The in-process cache must NOT be that lenient,
    // because it acts as a process-wide "the leader just refreshed THIS
    // identity" channel: a fuzzy hit could let a freshly-seeded credential
    // for an unrelated identity adopt a peer's rotated token. Require both
    // sides to bear identity and to match.
    if (!hasOAuthIdentity(requesting) || !hasOAuthIdentity(cached)) {
      return null;
    }
    if (!isSafeToAdoptMainStoreOAuthIdentity(requesting, cached)) {
      return null;
    }
    return cached;
  }

  function adoptNewerMainOAuthCredential(params: {
    store: AuthProfileStore;
    profileId: string;
    agentDir?: string;
    credential: OAuthCredential;
  }): OAuthCredential | null {
    if (!params.agentDir) {
      return null;
    }
    // Prefer the in-process refresh result over disk: it is always at least
    // as fresh as main on disk and is the only source guaranteed to survive
    // a dropped mirror (#74055). Mirror the disk path's freshness guard so a
    // still-valid local credential is not silently rewritten just because a
    // peer's rotation result is sitting in the cache; only adopt when the
    // cached credential is strictly newer (or local has no finite expiry).
    const cached = findInProcessRefreshedCredential(
      params.credential.provider,
      params.profileId,
      params.credential,
    );
    if (
      cached &&
      Number.isFinite(cached.expires) &&
      (!Number.isFinite(params.credential.expires) || cached.expires > params.credential.expires)
    ) {
      params.store.profiles[params.profileId] = { ...cached };
      saveAuthProfileStore(params.store, params.agentDir);
      log.info("adopted newer OAuth credentials from in-process refresh cache", {
        profileId: params.profileId,
        agentDir: params.agentDir,
        expires: new Date(cached.expires).toISOString(),
      });
      return cached;
    }
    try {
      const mainStore = ensureAuthProfileStore(undefined);
      const mainCred = mainStore.profiles[params.profileId];
      if (
        mainCred?.type === "oauth" &&
        mainCred.provider === params.credential.provider &&
        hasUsableOAuthCredential(mainCred) &&
        Number.isFinite(mainCred.expires) &&
        (!Number.isFinite(params.credential.expires) ||
          mainCred.expires > params.credential.expires) &&
        isSafeToAdoptMainStoreOAuthIdentity(params.credential, mainCred)
      ) {
        params.store.profiles[params.profileId] = { ...mainCred };
        log.info("adopted newer OAuth credentials from main agent", {
          profileId: params.profileId,
          agentDir: params.agentDir,
          expires: new Date(mainCred.expires).toISOString(),
        });
        return mainCred;
      }
    } catch (err) {
      log.debug("adoptNewerMainOAuthCredential failed", {
        profileId: params.profileId,
        error: formatErrorMessage(err),
      });
    }
    return null;
  }

  const refreshQueues = new Map<string, Promise<unknown>>();

  async function withRefreshCallTimeout<T>(
    label: string,
    timeoutMs: number,
    fn: () => Promise<T>,
  ): Promise<T> {
    let timeoutHandle: NodeJS.Timeout | undefined;
    try {
      return await new Promise<T>((resolve, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`OAuth refresh call "${label}" exceeded hard timeout (${timeoutMs}ms)`));
        }, timeoutMs);
        fn().then(resolve, reject);
      });
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  async function mirrorRefreshedCredentialIntoMainStore(params: {
    profileId: string;
    refreshed: OAuthCredential;
  }): Promise<void> {
    try {
      const mainPath = resolveAuthStorePath(undefined);
      ensureAuthStoreFile(mainPath);
      await updateAuthProfileStoreWithLock({
        agentDir: undefined,
        updater: (store) => {
          const existing = store.profiles[params.profileId];
          const decision = shouldMirrorRefreshedOAuthCredential({
            existing,
            refreshed: params.refreshed,
          });
          if (!decision.shouldMirror) {
            if (decision.reason === "identity-mismatch-or-regression") {
              log.warn("refused to mirror OAuth credential: identity mismatch or regression", {
                profileId: params.profileId,
              });
            }
            return false;
          }
          store.profiles[params.profileId] = { ...params.refreshed };
          log.debug("mirrored refreshed OAuth credential to main agent store", {
            profileId: params.profileId,
            expires: Number.isFinite(params.refreshed.expires)
              ? new Date(params.refreshed.expires).toISOString()
              : undefined,
          });
          return true;
        },
      });
    } catch (err) {
      log.debug("mirrorRefreshedCredentialIntoMainStore failed", {
        profileId: params.profileId,
        error: formatErrorMessage(err),
      });
    }
  }

  async function doRefreshOAuthTokenWithLock(params: {
    profileId: string;
    provider: string;
    agentDir?: string;
  }): Promise<ResolvedOAuthAccess | null> {
    const ownerAgentDir = resolvePersistedAuthProfileOwnerAgentDir(params);
    const authPath = resolveAuthStorePath(ownerAgentDir);
    ensureAuthStoreFile(authPath);
    const globalRefreshLockPath = resolveOAuthRefreshLockPath(params.provider, params.profileId);

    try {
      return await withFileLock(globalRefreshLockPath, OAUTH_REFRESH_LOCK_OPTIONS, async () =>
        withFileLock(authPath, AUTH_STORE_LOCK_OPTIONS, async () => {
          const store = loadAuthProfileStoreForSecretsRuntime(ownerAgentDir);
          const cred = store.profiles[params.profileId];
          if (!cred || cred.type !== "oauth") {
            return null;
          }
          let credentialToRefresh = cred;

          if (hasUsableOAuthCredential(cred)) {
            return {
              apiKey: await adapter.buildApiKey(cred.provider, cred),
              credential: cred,
            };
          }

          // Defense in depth before consulting main on disk: the leader of
          // the in-process refresh queue may have just refreshed under the
          // same lock and returned. The mirror to main is best-effort, so
          // we cannot rely on disk being up to date — see the cache notes
          // on `recentlyRefreshedCredentials` (#74055).
          if (params.agentDir) {
            const cachedFromPeer = findInProcessRefreshedCredential(
              params.provider,
              params.profileId,
              cred,
            );
            if (cachedFromPeer) {
              store.profiles[params.profileId] = { ...cachedFromPeer };
              saveAuthProfileStore(store, params.agentDir);
              log.info(
                "adopted fresh OAuth credential from in-process refresh cache (under refresh lock)",
                {
                  profileId: params.profileId,
                  agentDir: params.agentDir,
                  expires: new Date(cachedFromPeer.expires).toISOString(),
                },
              );
              return {
                apiKey: await adapter.buildApiKey(cachedFromPeer.provider, cachedFromPeer),
                credential: cachedFromPeer,
              };
            }
          }

          if (params.agentDir) {
            try {
              const mainStore = loadAuthProfileStoreForSecretsRuntime(undefined);
              const mainCred = mainStore.profiles[params.profileId];
              if (
                mainCred?.type === "oauth" &&
                mainCred.provider === cred.provider &&
                hasUsableOAuthCredential(mainCred) &&
                isSafeToAdoptMainStoreOAuthIdentity(cred, mainCred)
              ) {
                store.profiles[params.profileId] = { ...mainCred };
                log.info("adopted fresh OAuth credential from main store (under refresh lock)", {
                  profileId: params.profileId,
                  agentDir: params.agentDir,
                  expires: new Date(mainCred.expires).toISOString(),
                });
                return {
                  apiKey: await adapter.buildApiKey(mainCred.provider, mainCred),
                  credential: mainCred,
                };
              } else if (
                mainCred?.type === "oauth" &&
                mainCred.provider === cred.provider &&
                hasUsableOAuthCredential(mainCred) &&
                !isSafeToAdoptMainStoreOAuthIdentity(cred, mainCred)
              ) {
                log.warn("refused to adopt fresh main-store OAuth credential: identity mismatch", {
                  profileId: params.profileId,
                  agentDir: params.agentDir,
                });
              }
            } catch (err) {
              log.debug("inside-lock main-store adoption failed; proceeding to refresh", {
                profileId: params.profileId,
                error: formatErrorMessage(err),
              });
            }
          }

          const externallyManaged = adapter.readBootstrapCredential({
            profileId: params.profileId,
            credential: cred,
          });
          if (externallyManaged) {
            if (externallyManaged.provider !== cred.provider) {
              log.warn("refused external oauth bootstrap credential: provider mismatch", {
                profileId: params.profileId,
                provider: cred.provider,
              });
            } else if (!isSafeToAdoptBootstrapOAuthIdentity(cred, externallyManaged)) {
              log.warn(
                "refused external oauth bootstrap credential: identity mismatch or missing binding",
                {
                  profileId: params.profileId,
                  provider: cred.provider,
                },
              );
            } else {
              if (
                shouldReplaceStoredOAuthCredential(cred, externallyManaged) &&
                !areOAuthCredentialsEquivalent(cred, externallyManaged)
              ) {
                store.profiles[params.profileId] = { ...externallyManaged };
                saveAuthProfileStore(store, ownerAgentDir);
              }
              credentialToRefresh = externallyManaged;
              if (hasUsableOAuthCredential(externallyManaged)) {
                return {
                  apiKey: await adapter.buildApiKey(externallyManaged.provider, externallyManaged),
                  credential: externallyManaged,
                };
              }
            }
          }

          const refreshedCredentials = await withRefreshCallTimeout(
            `refreshOAuthCredential(${cred.provider})`,
            OAUTH_REFRESH_CALL_TIMEOUT_MS,
            async () => {
              const refreshed = await adapter.refreshCredential(credentialToRefresh);
              return refreshed
                ? ({
                    ...credentialToRefresh,
                    ...refreshed,
                    type: "oauth",
                  } satisfies OAuthCredential)
                : null;
            },
          );
          if (!refreshedCredentials) {
            return null;
          }
          // Publish the rotated credential to the in-process cache before
          // doing anything that can fail (mirror, save) so peers waiting
          // behind us in the refresh queue can adopt this result even if
          // the disk-side mirror is dropped. The cache is the only
          // recovery seam that survives a silent mirror failure (#74055).
          rememberRefreshedCredential(params.provider, params.profileId, refreshedCredentials);
          store.profiles[params.profileId] = refreshedCredentials;
          saveAuthProfileStore(store, ownerAgentDir);
          if (ownerAgentDir) {
            const mainPath = resolveAuthStorePath(undefined);
            if (mainPath !== authPath) {
              await mirrorRefreshedCredentialIntoMainStore({
                profileId: params.profileId,
                refreshed: refreshedCredentials,
              });
            }
          }
          return {
            apiKey: await adapter.buildApiKey(cred.provider, refreshedCredentials),
            credential: refreshedCredentials,
          };
        }),
      );
    } catch (error) {
      if (isGlobalRefreshLockTimeoutError(error, globalRefreshLockPath)) {
        throw buildRefreshContentionError({
          provider: params.provider,
          profileId: params.profileId,
          cause: error,
        });
      }
      throw error;
    }
  }

  async function refreshOAuthTokenWithLock(params: {
    profileId: string;
    provider: string;
    agentDir?: string;
  }): Promise<ResolvedOAuthAccess | null> {
    const key = refreshQueueKey(params.provider, params.profileId);
    const prev = refreshQueues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    refreshQueues.set(key, gate);
    try {
      await prev;
      return await doRefreshOAuthTokenWithLock(params);
    } finally {
      release();
      if (refreshQueues.get(key) === gate) {
        refreshQueues.delete(key);
      }
    }
  }

  async function resolveOAuthAccess(params: {
    store: AuthProfileStore;
    profileId: string;
    credential: OAuthCredential;
    agentDir?: string;
  }): Promise<ResolvedOAuthAccess | null> {
    const adoptedCredential =
      adoptNewerMainOAuthCredential({
        store: params.store,
        profileId: params.profileId,
        agentDir: params.agentDir,
        credential: params.credential,
      }) ?? params.credential;
    const effectiveCredential = resolveEffectiveOAuthCredential({
      profileId: params.profileId,
      credential: adoptedCredential,
      readBootstrapCredential: adapter.readBootstrapCredential,
    });

    if (hasUsableOAuthCredential(effectiveCredential)) {
      return {
        apiKey: await adapter.buildApiKey(effectiveCredential.provider, effectiveCredential),
        credential: effectiveCredential,
      };
    }

    try {
      const refreshed = await refreshOAuthTokenWithLock({
        profileId: params.profileId,
        provider: params.credential.provider,
        agentDir: params.agentDir,
      });
      return refreshed;
    } catch (error) {
      const refreshedStore = loadAuthProfileStoreForSecretsRuntime(params.agentDir);
      const refreshed = refreshedStore.profiles[params.profileId];
      if (refreshed?.type === "oauth" && hasUsableOAuthCredential(refreshed)) {
        return {
          apiKey: await adapter.buildApiKey(refreshed.provider, refreshed),
          credential: refreshed,
        };
      }
      if (
        adapter.isRefreshTokenReusedError(error) &&
        refreshed?.type === "oauth" &&
        refreshed.provider === params.credential.provider &&
        hasOAuthCredentialChanged(params.credential, refreshed)
      ) {
        const recovered = await loadFreshStoredOAuthCredential({
          profileId: params.profileId,
          agentDir: params.agentDir,
          provider: params.credential.provider,
          previous: params.credential,
          requireChange: true,
        });
        if (recovered) {
          return {
            apiKey: await adapter.buildApiKey(recovered.provider, recovered),
            credential: recovered,
          };
        }
        try {
          const retried = await refreshOAuthTokenWithLock({
            profileId: params.profileId,
            provider: params.credential.provider,
            agentDir: params.agentDir,
          });
          if (retried) {
            return retried;
          }
        } catch {
          // Retry failed too; keep flowing through the main-store fallback
          // and final wrapped error path below.
        }
      }
      if (params.agentDir) {
        // The leader's refresh may have populated the in-process cache
        // before our refresh attempt failed (timing of error vs. cache
        // publish under the lock). Honor the cache before falling back to
        // the disk-side main store so #74055-class mirror losses do not
        // turn a recoverable race into a thrown OAuthManagerRefreshError.
        // Match against `params.credential` (the original stale credential
        // that entered resolveOAuthAccess) rather than the disk-reloaded
        // `refreshed`: identity must be evaluated from the caller's known
        // starting point, not from a disk view that may itself have just
        // been rolled back to the same pre-rotation state.
        const cachedFromPeer = findInProcessRefreshedCredential(
          params.credential.provider,
          params.profileId,
          params.credential,
        );
        if (cachedFromPeer) {
          refreshedStore.profiles[params.profileId] = { ...cachedFromPeer };
          saveAuthProfileStore(refreshedStore, params.agentDir);
          log.info("inherited fresh OAuth credentials from in-process refresh cache", {
            profileId: params.profileId,
            agentDir: params.agentDir,
            expires: new Date(cachedFromPeer.expires).toISOString(),
          });
          return {
            apiKey: await adapter.buildApiKey(cachedFromPeer.provider, cachedFromPeer),
            credential: cachedFromPeer,
          };
        }
        try {
          const mainStore = ensureAuthProfileStore(undefined);
          const mainCred = mainStore.profiles[params.profileId];
          if (
            mainCred?.type === "oauth" &&
            mainCred.provider === params.credential.provider &&
            hasUsableOAuthCredential(mainCred) &&
            isSafeToAdoptMainStoreOAuthIdentity(params.credential, mainCred)
          ) {
            refreshedStore.profiles[params.profileId] = { ...mainCred };
            log.info("inherited fresh OAuth credentials from main agent", {
              profileId: params.profileId,
              agentDir: params.agentDir,
              expires: new Date(mainCred.expires).toISOString(),
            });
            return {
              apiKey: await adapter.buildApiKey(mainCred.provider, mainCred),
              credential: mainCred,
            };
          }
        } catch {
          // keep the original refresh error below
        }
      }
      throw new OAuthManagerRefreshError({
        credential: params.credential,
        profileId: params.profileId,
        refreshedStore,
        cause: error,
      });
    }
  }

  function resetRefreshQueuesForTest(): void {
    refreshQueues.clear();
    recentlyRefreshedCredentials.clear();
  }

  return {
    resolveOAuthAccess,
    resetRefreshQueuesForTest,
  };
}
