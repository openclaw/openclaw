import { formatErrorMessage } from "../../infra/errors.js";
import { withFileLock } from "../../infra/file-lock.js";
import { AUTH_STORE_LOCK_OPTIONS, OAUTH_REFRESH_CALL_TIMEOUT_MS, OAUTH_REFRESH_LOCK_OPTIONS, log, } from "./constants.js";
import { shouldMirrorRefreshedOAuthCredential } from "./oauth-identity.js";
import { buildRefreshContentionError, isGlobalRefreshLockTimeoutError, } from "./oauth-refresh-lock-errors.js";
import { areOAuthCredentialsEquivalent, hasUsableOAuthCredential, isSafeToAdoptBootstrapOAuthIdentity, isSafeToAdoptMainStoreOAuthIdentity, isSafeToOverwriteStoredOAuthIdentity, overlayRuntimeExternalOAuthProfiles, shouldBootstrapFromExternalCliCredential, shouldPersistRuntimeExternalOAuthProfile, shouldReplaceStoredOAuthCredential, } from "./oauth-shared.js";
import { ensureAuthStoreFile, resolveAuthStorePath, resolveOAuthRefreshLockPath } from "./paths.js";
import { ensureAuthProfileStore, loadAuthProfileStoreForSecretsRuntime, saveAuthProfileStore, updateAuthProfileStoreWithLock, } from "./store.js";
export class OAuthManagerRefreshError extends Error {
    profileId;
    provider;
    code;
    lockPath;
    #refreshedStore;
    #credential;
    constructor(params) {
        const structuredCause = typeof params.cause === "object" && params.cause !== null
            ? params.cause
            : undefined;
        const delegatedCause = structuredCause?.code === "refresh_contention" && structuredCause.cause
            ? structuredCause.cause
            : params.cause;
        super(`OAuth token refresh failed for ${params.credential.provider}: ${formatErrorMessage(params.cause)}`, { cause: delegatedCause });
        this.name = "OAuthManagerRefreshError";
        this.#credential = params.credential;
        this.profileId = params.profileId;
        this.provider = params.credential.provider;
        this.#refreshedStore = params.refreshedStore;
        if (structuredCause) {
            this.code = typeof structuredCause.code === "string" ? structuredCause.code : undefined;
            if (typeof structuredCause.lockPath === "string") {
                this.lockPath = structuredCause.lockPath;
            }
            else if (typeof structuredCause.cause === "object" &&
                structuredCause.cause !== null &&
                "lockPath" in structuredCause.cause &&
                typeof structuredCause.cause.lockPath === "string") {
                this.lockPath = structuredCause.cause.lockPath;
            }
        }
    }
    getRefreshedStore() {
        return this.#refreshedStore;
    }
    getCredential() {
        return this.#credential;
    }
    toJSON() {
        return {
            name: this.name,
            message: this.message,
            profileId: this.profileId,
            provider: this.provider,
        };
    }
}
export { areOAuthCredentialsEquivalent, hasUsableOAuthCredential, isSafeToAdoptBootstrapOAuthIdentity, isSafeToAdoptMainStoreOAuthIdentity, isSafeToOverwriteStoredOAuthIdentity, overlayRuntimeExternalOAuthProfiles, shouldBootstrapFromExternalCliCredential, shouldPersistRuntimeExternalOAuthProfile, shouldReplaceStoredOAuthCredential, };
function hasOAuthCredentialChanged(previous, current) {
    return (previous.access !== current.access ||
        previous.refresh !== current.refresh ||
        previous.expires !== current.expires);
}
async function loadFreshStoredOAuthCredential(params) {
    const reloadedStore = loadAuthProfileStoreForSecretsRuntime(params.agentDir);
    const reloaded = reloadedStore.profiles[params.profileId];
    if (reloaded?.type !== "oauth" ||
        reloaded.provider !== params.provider ||
        !hasUsableOAuthCredential(reloaded)) {
        return null;
    }
    if (params.requireChange &&
        params.previous &&
        !hasOAuthCredentialChanged(params.previous, reloaded)) {
        return null;
    }
    return reloaded;
}
export function resolveEffectiveOAuthCredential(params) {
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
export function createOAuthManager(adapter) {
    function adoptNewerMainOAuthCredential(params) {
        if (!params.agentDir) {
            return null;
        }
        try {
            const mainStore = ensureAuthProfileStore(undefined);
            const mainCred = mainStore.profiles[params.profileId];
            if (mainCred?.type === "oauth" &&
                mainCred.provider === params.credential.provider &&
                hasUsableOAuthCredential(mainCred) &&
                Number.isFinite(mainCred.expires) &&
                (!Number.isFinite(params.credential.expires) ||
                    mainCred.expires > params.credential.expires) &&
                isSafeToAdoptMainStoreOAuthIdentity(params.credential, mainCred)) {
                params.store.profiles[params.profileId] = { ...mainCred };
                saveAuthProfileStore(params.store, params.agentDir);
                log.info("adopted newer OAuth credentials from main agent", {
                    profileId: params.profileId,
                    agentDir: params.agentDir,
                    expires: new Date(mainCred.expires).toISOString(),
                });
                return mainCred;
            }
        }
        catch (err) {
            log.debug("adoptNewerMainOAuthCredential failed", {
                profileId: params.profileId,
                error: formatErrorMessage(err),
            });
        }
        return null;
    }
    const refreshQueues = new Map();
    function refreshQueueKey(provider, profileId) {
        return `${provider}\u0000${profileId}`;
    }
    async function withRefreshCallTimeout(label, timeoutMs, fn) {
        let timeoutHandle;
        try {
            return await new Promise((resolve, reject) => {
                timeoutHandle = setTimeout(() => {
                    reject(new Error(`OAuth refresh call "${label}" exceeded hard timeout (${timeoutMs}ms)`));
                }, timeoutMs);
                fn().then(resolve, reject);
            });
        }
        finally {
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
            }
        }
    }
    async function mirrorRefreshedCredentialIntoMainStore(params) {
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
        }
        catch (err) {
            log.debug("mirrorRefreshedCredentialIntoMainStore failed", {
                profileId: params.profileId,
                error: formatErrorMessage(err),
            });
        }
    }
    async function doRefreshOAuthTokenWithLock(params) {
        const authPath = resolveAuthStorePath(params.agentDir);
        ensureAuthStoreFile(authPath);
        const globalRefreshLockPath = resolveOAuthRefreshLockPath(params.provider, params.profileId);
        try {
            return await withFileLock(globalRefreshLockPath, OAUTH_REFRESH_LOCK_OPTIONS, async () => withFileLock(authPath, AUTH_STORE_LOCK_OPTIONS, async () => {
                const store = loadAuthProfileStoreForSecretsRuntime(params.agentDir);
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
                if (params.agentDir) {
                    try {
                        const mainStore = loadAuthProfileStoreForSecretsRuntime(undefined);
                        const mainCred = mainStore.profiles[params.profileId];
                        if (mainCred?.type === "oauth" &&
                            mainCred.provider === cred.provider &&
                            hasUsableOAuthCredential(mainCred) &&
                            isSafeToAdoptMainStoreOAuthIdentity(cred, mainCred)) {
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
                        }
                        else if (mainCred?.type === "oauth" &&
                            mainCred.provider === cred.provider &&
                            hasUsableOAuthCredential(mainCred) &&
                            !isSafeToAdoptMainStoreOAuthIdentity(cred, mainCred)) {
                            log.warn("refused to adopt fresh main-store OAuth credential: identity mismatch", {
                                profileId: params.profileId,
                                agentDir: params.agentDir,
                            });
                        }
                    }
                    catch (err) {
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
                    }
                    else if (!isSafeToAdoptBootstrapOAuthIdentity(cred, externallyManaged)) {
                        log.warn("refused external oauth bootstrap credential: identity mismatch or missing binding", {
                            profileId: params.profileId,
                            provider: cred.provider,
                        });
                    }
                    else {
                        if (shouldReplaceStoredOAuthCredential(cred, externallyManaged) &&
                            !areOAuthCredentialsEquivalent(cred, externallyManaged)) {
                            store.profiles[params.profileId] = { ...externallyManaged };
                            saveAuthProfileStore(store, params.agentDir);
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
                const refreshedCredentials = await withRefreshCallTimeout(`refreshOAuthCredential(${cred.provider})`, OAUTH_REFRESH_CALL_TIMEOUT_MS, async () => {
                    const refreshed = await adapter.refreshCredential(credentialToRefresh);
                    return refreshed
                        ? {
                            ...credentialToRefresh,
                            ...refreshed,
                            type: "oauth",
                        }
                        : null;
                });
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
            }));
        }
        catch (error) {
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
    async function refreshOAuthTokenWithLock(params) {
        const key = refreshQueueKey(params.provider, params.profileId);
        const prev = refreshQueues.get(key) ?? Promise.resolve();
        let release;
        const gate = new Promise((resolve) => {
            release = resolve;
        });
        refreshQueues.set(key, gate);
        try {
            await prev;
            return await doRefreshOAuthTokenWithLock(params);
        }
        finally {
            release();
            if (refreshQueues.get(key) === gate) {
                refreshQueues.delete(key);
            }
        }
    }
    async function resolveOAuthAccess(params) {
        const adoptedCredential = adoptNewerMainOAuthCredential({
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
        }
        catch (error) {
            const refreshedStore = loadAuthProfileStoreForSecretsRuntime(params.agentDir);
            const refreshed = refreshedStore.profiles[params.profileId];
            if (refreshed?.type === "oauth" && hasUsableOAuthCredential(refreshed)) {
                return {
                    apiKey: await adapter.buildApiKey(refreshed.provider, refreshed),
                    credential: refreshed,
                };
            }
            if (adapter.isRefreshTokenReusedError(error) &&
                refreshed?.type === "oauth" &&
                refreshed.provider === params.credential.provider &&
                hasOAuthCredentialChanged(params.credential, refreshed)) {
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
                }
                catch {
                    // Retry failed too; keep flowing through the main-store fallback
                    // and final wrapped error path below.
                }
            }
            if (params.agentDir) {
                try {
                    const mainStore = ensureAuthProfileStore(undefined);
                    const mainCred = mainStore.profiles[params.profileId];
                    if (mainCred?.type === "oauth" &&
                        mainCred.provider === params.credential.provider &&
                        hasUsableOAuthCredential(mainCred) &&
                        isSafeToAdoptMainStoreOAuthIdentity(params.credential, mainCred)) {
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
                }
                catch {
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
    function resetRefreshQueuesForTest() {
        refreshQueues.clear();
    }
    return {
        resolveOAuthAccess,
        resetRefreshQueuesForTest,
    };
}
