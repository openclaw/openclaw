import { formatErrorMessage } from "../../infra/errors.js";
import { withFileLock } from "../../infra/file-lock.js";
import {
  AUTH_STORE_LOCK_OPTIONS,
  OAUTH_REFRESH_CALL_TIMEOUT_MS,
  OAUTH_REFRESH_LOCK_OPTIONS,
  log,
} from "./constants.js";
import { hasUsableOAuthCredential as hasUsableStoredOAuthCredential } from "./credential-state.js";
import { ensureAuthStoreFile, resolveAuthStorePath, resolveOAuthRefreshLockPath } from "./paths.js";
import {
  ensureAuthProfileStore,
  loadAuthProfileStoreForSecretsRuntime,
  saveAuthProfileStore,
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
  isSafeToCopyOAuthIdentity: (
    existing: Pick<OAuthCredential, "accountId" | "email">,
    incoming: Pick<OAuthCredential, "accountId" | "email">,
  ) => boolean;
};

export type ResolvedOAuthAccess = {
  apiKey: string;
  credential: OAuthCredential;
};

export class OAuthManagerRefreshError extends Error {
  readonly profileId: string;
  readonly provider: string;
  readonly #refreshedStore: AuthProfileStore;
  readonly #credential: OAuthCredential;

  constructor(params: {
    credential: OAuthCredential;
    profileId: string;
    refreshedStore: AuthProfileStore;
    cause: unknown;
  }) {
    super(
      `OAuth token refresh failed for ${params.credential.provider}: ${formatErrorMessage(params.cause)}`,
      { cause: params.cause },
    );
    this.name = "OAuthManagerRefreshError";
    this.#credential = params.credential;
    this.profileId = params.profileId;
    this.provider = params.credential.provider;
    this.#refreshedStore = params.refreshedStore;
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

export type RuntimeExternalOAuthProfile = {
  profileId: string;
  credential: OAuthCredential;
  persistence?: "runtime-only" | "persisted";
};

export function areOAuthCredentialsEquivalent(
  a: OAuthCredential | undefined,
  b: OAuthCredential,
): boolean {
  if (!a || a.type !== "oauth") {
    return false;
  }
  return (
    a.provider === b.provider &&
    a.access === b.access &&
    a.refresh === b.refresh &&
    a.expires === b.expires &&
    a.email === b.email &&
    a.enterpriseUrl === b.enterpriseUrl &&
    a.projectId === b.projectId &&
    a.accountId === b.accountId
  );
}

function hasNewerStoredOAuthCredential(
  existing: OAuthCredential | undefined,
  incoming: OAuthCredential,
): boolean {
  return Boolean(
    existing &&
    existing.provider === incoming.provider &&
    Number.isFinite(existing.expires) &&
    (!Number.isFinite(incoming.expires) || existing.expires > incoming.expires),
  );
}

export function shouldReplaceStoredOAuthCredential(
  existing: OAuthCredential | undefined,
  incoming: OAuthCredential,
): boolean {
  if (!existing || existing.type !== "oauth") {
    return true;
  }
  if (areOAuthCredentialsEquivalent(existing, incoming)) {
    return false;
  }
  return !hasNewerStoredOAuthCredential(existing, incoming);
}

export function hasUsableOAuthCredential(
  credential: OAuthCredential | undefined,
  now = Date.now(),
): boolean {
  return hasUsableStoredOAuthCredential(credential, { now });
}

function normalizeAuthIdentityToken(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeAuthEmailToken(value: string | undefined): string | undefined {
  return normalizeAuthIdentityToken(value)?.toLowerCase();
}

function hasOAuthIdentity(credential: Pick<OAuthCredential, "accountId" | "email">): boolean {
  return (
    normalizeAuthIdentityToken(credential.accountId) !== undefined ||
    normalizeAuthEmailToken(credential.email) !== undefined
  );
}

function hasMatchingOAuthIdentity(
  existing: Pick<OAuthCredential, "accountId" | "email">,
  incoming: Pick<OAuthCredential, "accountId" | "email">,
): boolean {
  const existingAccountId = normalizeAuthIdentityToken(existing.accountId);
  const incomingAccountId = normalizeAuthIdentityToken(incoming.accountId);
  if (existingAccountId !== undefined && incomingAccountId !== undefined) {
    return existingAccountId === incomingAccountId;
  }

  const existingEmail = normalizeAuthEmailToken(existing.email);
  const incomingEmail = normalizeAuthEmailToken(incoming.email);
  if (existingEmail !== undefined && incomingEmail !== undefined) {
    return existingEmail === incomingEmail;
  }

  return false;
}

export function isSafeToOverwriteStoredOAuthIdentity(
  existing: OAuthCredential | undefined,
  incoming: OAuthCredential,
): boolean {
  if (!existing || existing.type !== "oauth") {
    return true;
  }
  if (existing.provider !== incoming.provider) {
    return false;
  }
  if (areOAuthCredentialsEquivalent(existing, incoming)) {
    return true;
  }
  if (!hasOAuthIdentity(existing)) {
    return false;
  }
  return hasMatchingOAuthIdentity(existing, incoming);
}

export function shouldBootstrapFromExternalCliCredential(params: {
  existing: OAuthCredential | undefined;
  imported: OAuthCredential;
  now?: number;
}): boolean {
  const now = params.now ?? Date.now();
  if (hasUsableOAuthCredential(params.existing, now)) {
    return false;
  }
  return hasUsableOAuthCredential(params.imported, now);
}

export function overlayRuntimeExternalOAuthProfiles(
  store: AuthProfileStore,
  profiles: Iterable<RuntimeExternalOAuthProfile>,
): AuthProfileStore {
  const externalProfiles = Array.from(profiles);
  if (externalProfiles.length === 0) {
    return store;
  }
  const next = structuredClone(store);
  for (const profile of externalProfiles) {
    next.profiles[profile.profileId] = profile.credential;
  }
  return next;
}

export function shouldPersistRuntimeExternalOAuthProfile(params: {
  profileId: string;
  credential: OAuthCredential;
  profiles: Iterable<RuntimeExternalOAuthProfile>;
}): boolean {
  for (const profile of params.profiles) {
    if (profile.profileId !== params.profileId) {
      continue;
    }
    if (profile.persistence === "persisted") {
      return true;
    }
    return !areOAuthCredentialsEquivalent(profile.credential, params.credential);
  }
  return true;
}

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
  if (!isSafeToOverwriteStoredOAuthIdentity(params.credential, imported)) {
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
  function adoptNewerMainOAuthCredential(params: {
    store: AuthProfileStore;
    profileId: string;
    agentDir?: string;
    credential: OAuthCredential;
  }): OAuthCredential | null {
    if (!params.agentDir) {
      return null;
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
        adapter.isSafeToCopyOAuthIdentity(params.credential, mainCred)
      ) {
        params.store.profiles[params.profileId] = { ...mainCred };
        saveAuthProfileStore(params.store, params.agentDir);
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

  function refreshQueueKey(provider: string, profileId: string): string {
    return `${provider}\u0000${profileId}`;
  }

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
          if (existing && existing.type !== "oauth") {
            return false;
          }
          if (existing && existing.provider !== params.refreshed.provider) {
            return false;
          }
          if (existing && !isSafeToOverwriteStoredOAuthIdentity(existing, params.refreshed)) {
            log.warn("refused to mirror OAuth credential: identity mismatch or regression", {
              profileId: params.profileId,
            });
            return false;
          }
          if (
            existing &&
            Number.isFinite(existing.expires) &&
            Number.isFinite(params.refreshed.expires) &&
            existing.expires >= params.refreshed.expires
          ) {
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
    const authPath = resolveAuthStorePath(params.agentDir);
    ensureAuthStoreFile(authPath);
    const globalRefreshLockPath = resolveOAuthRefreshLockPath(params.provider, params.profileId);

    return await withFileLock(globalRefreshLockPath, OAUTH_REFRESH_LOCK_OPTIONS, async () =>
      withFileLock(authPath, AUTH_STORE_LOCK_OPTIONS, async () => {
        const store = loadAuthProfileStoreForSecretsRuntime(params.agentDir);
        const cred = store.profiles[params.profileId];
        if (!cred || cred.type !== "oauth") {
          return null;
        }

        if (hasUsableOAuthCredential(cred)) {
          return {
            apiKey: await adapter.buildApiKey(cred.provider, cred),
            credential: cred,
          };
        }

        if (params.agentDir) {
          try {
            const mainStore = loadAuthProfileStoreForSecretsRuntime(undefined);
            const mainCred = mainStore.profiles[params.profileId];
            if (
              mainCred?.type === "oauth" &&
              mainCred.provider === cred.provider &&
              hasUsableOAuthCredential(mainCred) &&
              adapter.isSafeToCopyOAuthIdentity(cred, mainCred)
            ) {
              store.profiles[params.profileId] = { ...mainCred };
              saveAuthProfileStore(store, params.agentDir);
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
              !adapter.isSafeToCopyOAuthIdentity(cred, mainCred)
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
          } else if (!isSafeToOverwriteStoredOAuthIdentity(cred, externallyManaged)) {
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
              saveAuthProfileStore(store, params.agentDir);
            }
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
            const refreshed = await adapter.refreshCredential(cred);
            return refreshed
              ? ({
                  ...cred,
                  ...refreshed,
                  type: "oauth",
                } satisfies OAuthCredential)
              : null;
          },
        );
        if (!refreshedCredentials) {
          return null;
        }
        store.profiles[params.profileId] = refreshedCredentials;
        saveAuthProfileStore(store, params.agentDir);
        if (params.agentDir) {
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
        try {
          const mainStore = ensureAuthProfileStore(undefined);
          const mainCred = mainStore.profiles[params.profileId];
          if (
            mainCred?.type === "oauth" &&
            mainCred.provider === params.credential.provider &&
            hasUsableOAuthCredential(mainCred) &&
            adapter.isSafeToCopyOAuthIdentity(params.credential, mainCred)
          ) {
            refreshedStore.profiles[params.profileId] = { ...mainCred };
            saveAuthProfileStore(refreshedStore, params.agentDir);
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
  }

  return {
    resolveOAuthAccess,
    resetRefreshQueuesForTest,
  };
}
