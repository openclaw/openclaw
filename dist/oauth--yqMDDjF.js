import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { s as redactSensitiveText } from "./redact-ok5Q8nmw.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { d as normalizeSecretInputString, o as coerceSecretRef } from "./types.secrets-DwPik3M8.js";
import { r as normalizeProviderId } from "./provider-id-zTW9Rdln.js";
import { i as resolveSecretRefString } from "./resolve-D1Ko6pWx.js";
import { i as getRuntimeConfig } from "./io-DoswVvYe.js";
import { r as resolveProviderIdForAuth } from "./provider-auth-aliases-4jqi6Djx.js";
import { o as withFileLock } from "./file-lock-D5OTq3qW.js";
import "./file-lock-BSRN56ID.js";
import "./config-B6Oplu5W.js";
import { i as hasRuntimeAuthProfileStoreSnapshot, n as getRuntimeAuthProfileStoreSnapshot, o as setRuntimeAuthProfileStoreSnapshot } from "./runtime-snapshots-esDr_mQ_.js";
import { o as resolveOAuthRefreshLockPath, r as resolveAuthStorePath } from "./path-resolve-C6Vj5eOM.js";
import { l as log, o as OAUTH_REFRESH_CALL_TIMEOUT_MS, s as OAUTH_REFRESH_LOCK_OPTIONS, t as AUTH_STORE_LOCK_OPTIONS } from "./constants-D_82oc2f.js";
import { A as shouldReplaceStoredOAuthCredential, C as readManagedExternalCliCredential, D as isSafeToAdoptBootstrapOAuthIdentity, E as hasUsableOAuthCredential, O as isSafeToAdoptMainStoreOAuthIdentity, P as resolveTokenExpiryState, S as readExternalCliFallbackCredential, T as hasMatchingOAuthIdentity, c as loadAuthProfileStoreForSecretsRuntime, d as resolvePersistedAuthProfileOwnerAgentDir, f as saveAuthProfileStore, i as ensureAuthProfileStoreWithoutExternalProfiles, k as shouldBootstrapFromExternalCliCredential, l as loadAuthProfileStoreWithoutExternalProfiles, p as updateAuthProfileStoreWithLock, w as areOAuthCredentialsEquivalent } from "./store-BMQkMM4l.js";
import { t as ensureAuthStoreFile } from "./paths-DuwII6c5.js";
import { i as formatProviderAuthProfileApiKeyWithPlugin, n as buildProviderAuthDoctorHintWithPlugin, o as refreshProviderOAuthCredentialWithPlugin } from "./provider-runtime.runtime.js";
import { t as normalizeOptionalSecretInput } from "./normalize-secret-input-CsdRhsMj.js";
import { a as refreshChutesTokens } from "./chutes-oauth-CixIqCkm.js";
import { t as assertNoOAuthSecretRefPolicyViolations } from "./policy-sFxeew7c.js";
import { t as clearLastGoodProfileWithLock } from "./profiles-9GB1thhi.js";
import { n as suggestOAuthProfileIdForLegacyDefault } from "./repair-BQzHL5co.js";
import { getOAuthApiKey, getOAuthProviders } from "@earendil-works/pi-ai/oauth";
//#region src/agents/auth-profiles/doctor.ts
/**
* Migration hints for deprecated/removed OAuth providers.
* Users with stale credentials should be guided to migrate.
*/
const DEPRECATED_PROVIDER_MIGRATION_HINTS = { "qwen-portal": "Qwen OAuth via portal.qwen.ai has been deprecated. Please migrate to Qwen Cloud Coding Plan. Run: openclaw onboard --auth-choice qwen-api-key (or qwen-api-key-cn for the China endpoint). Legacy modelstudio auth-choice ids still work." };
async function formatAuthDoctorHint(params) {
	const normalizedProvider = normalizeProviderId(params.provider);
	const migrationHint = DEPRECATED_PROVIDER_MIGRATION_HINTS[normalizedProvider];
	if (migrationHint) return migrationHint;
	const pluginHint = await buildProviderAuthDoctorHintWithPlugin({
		provider: normalizedProvider,
		context: {
			config: params.cfg,
			store: params.store,
			provider: normalizedProvider,
			profileId: params.profileId
		}
	});
	if (typeof pluginHint === "string" && pluginHint.trim()) return pluginHint;
	return "";
}
//#endregion
//#region src/agents/auth-profiles/oauth-identity.ts
function normalizeAuthIdentityToken(value) {
	const trimmed = value?.trim();
	return trimmed ? trimmed : void 0;
}
function normalizeAuthEmailToken(value) {
	return normalizeAuthIdentityToken(value)?.toLowerCase();
}
/**
* One-sided copy gate for both directions:
* - mirror: sub-agent refresh -> main-agent store
* - adopt: main-agent store -> sub-agent store
*/
function isSafeToCopyOAuthIdentity(existing, incoming) {
	const aAcct = normalizeAuthIdentityToken(existing.accountId);
	const bAcct = normalizeAuthIdentityToken(incoming.accountId);
	const aEmail = normalizeAuthEmailToken(existing.email);
	const bEmail = normalizeAuthEmailToken(incoming.email);
	if (aAcct !== void 0 && bAcct !== void 0) return aAcct === bAcct;
	if (aEmail !== void 0 && bEmail !== void 0) return aEmail === bEmail;
	if (aAcct !== void 0 || aEmail !== void 0) return false;
	return true;
}
function shouldMirrorRefreshedOAuthCredential(params) {
	const { existing, refreshed } = params;
	if (!existing) return {
		shouldMirror: true,
		reason: "no-existing-credential"
	};
	if (existing.type !== "oauth") return {
		shouldMirror: false,
		reason: "non-oauth-existing-credential"
	};
	if (existing.provider !== refreshed.provider) return {
		shouldMirror: false,
		reason: "provider-mismatch"
	};
	if (!isSafeToCopyOAuthIdentity(existing, refreshed)) return {
		shouldMirror: false,
		reason: "identity-mismatch-or-regression"
	};
	if (Number.isFinite(existing.expires) && Number.isFinite(refreshed.expires) && existing.expires >= refreshed.expires) return {
		shouldMirror: false,
		reason: "incoming-not-fresher"
	};
	return {
		shouldMirror: true,
		reason: "incoming-fresher"
	};
}
//#endregion
//#region src/agents/auth-profiles/oauth-refresh-lock-errors.ts
function isGlobalRefreshLockTimeoutError(error, lockPath) {
	const candidate = typeof error === "object" && error !== null ? error : void 0;
	return candidate?.code === "file_lock_timeout" && candidate.lockPath === `${lockPath}.lock`;
}
function buildRefreshContentionError(params) {
	return Object.assign(new Error(`OAuth refresh failed (refresh_contention): another process is already refreshing ${params.provider} for ${params.profileId}. Please wait for the in-flight refresh to finish and retry.`, { cause: params.cause }), {
		code: "refresh_contention",
		cause: params.cause
	});
}
//#endregion
//#region src/agents/auth-profiles/oauth-manager.ts
var OAuthManagerRefreshError = class extends Error {
	#refreshedStore;
	#credential;
	constructor(params) {
		const structuredCause = typeof params.cause === "object" && params.cause !== null ? params.cause : void 0;
		const delegatedCause = structuredCause?.code === "refresh_contention" && structuredCause.cause ? structuredCause.cause : params.cause;
		const storedCredential = params.refreshedStore.profiles[params.profileId];
		const secrets = collectOAuthCredentialSecrets(params.credential, ...params.attemptedCredentials ?? [], storedCredential?.type === "oauth" ? storedCredential : void 0);
		const causeMessage = formatRedactedOAuthRefreshError(params.cause, secrets);
		super(`OAuth token refresh failed for ${params.credential.provider}: ${causeMessage}`, { cause: createRedactedOAuthRefreshCause(delegatedCause, secrets) });
		this.name = "OAuthManagerRefreshError";
		this.#credential = params.credential;
		this.profileId = params.profileId;
		this.provider = params.credential.provider;
		this.#refreshedStore = params.refreshedStore;
		if (structuredCause) {
			this.code = typeof structuredCause.code === "string" ? structuredCause.code : void 0;
			if (typeof structuredCause.lockPath === "string") this.lockPath = structuredCause.lockPath;
			else if (typeof structuredCause.cause === "object" && structuredCause.cause !== null && "lockPath" in structuredCause.cause && typeof structuredCause.cause.lockPath === "string") this.lockPath = structuredCause.cause.lockPath;
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
			provider: this.provider
		};
	}
};
function hasOAuthCredentialChanged(previous, current) {
	return previous.access !== current.access || previous.refresh !== current.refresh || previous.expires !== current.expires;
}
function canReuseOAuthCredentialAfterRefreshFailure(params) {
	return !params.forceRefresh || hasOAuthCredentialChanged(params.attempted, params.candidate);
}
function collectOAuthCredentialSecrets(...credentials) {
	const secrets = /* @__PURE__ */ new Set();
	for (const credential of credentials) for (const secret of [
		credential?.access,
		credential?.refresh,
		credential?.idToken
	]) if (secret) secrets.add(secret);
	return Array.from(secrets).toSorted((a, b) => b.length - a.length);
}
function redactOAuthCredentialSecrets(message, secrets) {
	let redacted = message;
	for (const secret of secrets) redacted = redacted.split(secret).join("[redacted]");
	return redacted;
}
function formatRawErrorMessage(error) {
	if (error instanceof Error) {
		let formatted = error.message || error.name || "Error";
		let cause = error.cause;
		const seen = new Set([error]);
		while (cause && !seen.has(cause)) {
			seen.add(cause);
			if (cause instanceof Error) {
				if (cause.message) formatted += ` | ${cause.message}`;
				cause = cause.cause;
			} else if (typeof cause === "string") {
				formatted += ` | ${cause}`;
				break;
			} else break;
		}
		return formatted;
	}
	if (typeof error === "string" || typeof error === "number" || typeof error === "boolean" || typeof error === "bigint") return String(error);
	try {
		return JSON.stringify(error) ?? String(error);
	} catch {
		return Object.prototype.toString.call(error);
	}
}
function formatRedactedOAuthRefreshError(error, secrets) {
	return redactSensitiveText(redactOAuthCredentialSecrets(formatRawErrorMessage(error), secrets));
}
function createRedactedOAuthRefreshCause(cause, secrets) {
	const redacted = formatRedactedOAuthRefreshError(cause, secrets);
	const sanitized = new Error(redacted);
	if (cause instanceof Error && cause.name) sanitized.name = cause.name;
	return sanitized;
}
function loadStoredOAuthRefreshStore(agentDir) {
	return loadAuthProfileStoreWithoutExternalProfiles(agentDir, {
		allowKeychainPrompt: true,
		resolveLegacyOAuthSidecars: true
	});
}
async function loadFreshStoredOAuthCredential(params) {
	const reloaded = loadStoredOAuthRefreshStore(params.agentDir).profiles[params.profileId];
	if (reloaded?.type !== "oauth" || reloaded.provider !== params.provider || !hasUsableOAuthCredential(reloaded)) return null;
	if (params.requireChange && params.previous && !hasOAuthCredentialChanged(params.previous, reloaded)) return null;
	return reloaded;
}
function resolveEffectiveOAuthCredential(params) {
	const imported = params.readBootstrapCredential({
		profileId: params.profileId,
		credential: params.credential
	});
	if (!imported) return params.credential;
	if (hasUsableOAuthCredential(params.credential)) {
		log.debug("resolved oauth credential from canonical local store", {
			profileId: params.profileId,
			provider: params.credential.provider,
			localExpires: params.credential.expires,
			externalExpires: imported.expires
		});
		return params.credential;
	}
	if (!isSafeToAdoptBootstrapOAuthIdentity(params.credential, imported)) {
		log.warn("refused external oauth bootstrap credential: identity mismatch or missing binding", {
			profileId: params.profileId,
			provider: params.credential.provider
		});
		return params.credential;
	}
	if (shouldBootstrapFromExternalCliCredential({
		existing: params.credential,
		imported
	})) {
		log.debug("resolved oauth credential from external cli bootstrap", {
			profileId: params.profileId,
			provider: imported.provider,
			localExpires: params.credential.expires,
			externalExpires: imported.expires
		});
		return imported;
	}
	return params.credential;
}
function createOAuthManager(adapter) {
	function adoptNewerMainOAuthCredential(params) {
		if (!params.agentDir) return null;
		try {
			const mainCred = ensureAuthProfileStoreWithoutExternalProfiles(void 0, { allowKeychainPrompt: false }).profiles[params.profileId];
			if (mainCred?.type === "oauth" && mainCred.provider === params.credential.provider && hasUsableOAuthCredential(mainCred) && Number.isFinite(mainCred.expires) && (!Number.isFinite(params.credential.expires) || mainCred.expires > params.credential.expires) && isSafeToAdoptMainStoreOAuthIdentity(params.credential, mainCred)) {
				params.store.profiles[params.profileId] = { ...mainCred };
				log.info("adopted newer OAuth credentials from main agent", {
					profileId: params.profileId,
					agentDir: params.agentDir,
					expires: new Date(mainCred.expires).toISOString()
				});
				return mainCred;
			}
		} catch (err) {
			log.debug("adoptNewerMainOAuthCredential failed", {
				profileId: params.profileId,
				error: formatErrorMessage(err)
			});
		}
		return null;
	}
	const refreshQueues = /* @__PURE__ */ new Map();
	function refreshQueueKey(provider, profileId) {
		return `${provider}\u0000${profileId}`;
	}
	async function withRefreshCallTimeout(label, timeoutMs, fn) {
		let timeoutHandle;
		try {
			return await new Promise((resolve, reject) => {
				timeoutHandle = setTimeout(() => {
					reject(/* @__PURE__ */ new Error(`OAuth refresh call "${label}" exceeded hard timeout (${timeoutMs}ms)`));
				}, timeoutMs);
				fn().then(resolve, reject);
			});
		} finally {
			if (timeoutHandle) clearTimeout(timeoutHandle);
		}
	}
	async function mirrorRefreshedCredentialIntoMainStore(params) {
		try {
			ensureAuthStoreFile(resolveAuthStorePath(void 0));
			await updateAuthProfileStoreWithLock({
				agentDir: void 0,
				updater: (store) => {
					const existing = store.profiles[params.profileId];
					const decision = shouldMirrorRefreshedOAuthCredential({
						existing,
						refreshed: params.refreshed
					});
					if (!decision.shouldMirror) {
						if (decision.reason === "identity-mismatch-or-regression") log.warn("refused to mirror OAuth credential: identity mismatch or regression", { profileId: params.profileId });
						return false;
					}
					store.profiles[params.profileId] = { ...params.refreshed };
					log.debug("mirrored refreshed OAuth credential to main agent store", {
						profileId: params.profileId,
						expires: Number.isFinite(params.refreshed.expires) ? new Date(params.refreshed.expires).toISOString() : void 0
					});
					return true;
				}
			});
		} catch (err) {
			log.debug("mirrorRefreshedCredentialIntoMainStore failed", {
				profileId: params.profileId,
				error: formatErrorMessage(err)
			});
		}
	}
	async function doRefreshOAuthTokenWithLock(params) {
		const ownerAgentDir = resolvePersistedAuthProfileOwnerAgentDir(params);
		const authPath = resolveAuthStorePath(ownerAgentDir);
		ensureAuthStoreFile(authPath);
		const globalRefreshLockPath = resolveOAuthRefreshLockPath(params.provider, params.profileId);
		try {
			return await withFileLock(globalRefreshLockPath, OAUTH_REFRESH_LOCK_OPTIONS, async () => withFileLock(authPath, AUTH_STORE_LOCK_OPTIONS, async () => {
				const store = loadStoredOAuthRefreshStore(ownerAgentDir);
				const cred = store.profiles[params.profileId];
				if (!cred || cred.type !== "oauth") return null;
				let credentialToRefresh = cred;
				if (!params.forceRefresh && hasUsableOAuthCredential(cred)) return {
					apiKey: await adapter.buildApiKey(cred.provider, cred, {
						cfg: params.cfg,
						agentDir: params.agentDir
					}),
					credential: cred
				};
				if (params.agentDir) try {
					const mainCred = loadStoredOAuthRefreshStore(void 0).profiles[params.profileId];
					if (mainCred?.type === "oauth" && mainCred.provider === cred.provider && hasUsableOAuthCredential(mainCred) && !params.forceRefresh && isSafeToAdoptMainStoreOAuthIdentity(cred, mainCred)) {
						store.profiles[params.profileId] = { ...mainCred };
						log.info("adopted fresh OAuth credential from main store (under refresh lock)", {
							profileId: params.profileId,
							agentDir: params.agentDir,
							expires: new Date(mainCred.expires).toISOString()
						});
						return {
							apiKey: await adapter.buildApiKey(mainCred.provider, mainCred, {
								cfg: params.cfg,
								agentDir: params.agentDir
							}),
							credential: mainCred
						};
					} else if (mainCred?.type === "oauth" && mainCred.provider === cred.provider && hasUsableOAuthCredential(mainCred) && !isSafeToAdoptMainStoreOAuthIdentity(cred, mainCred)) log.warn("refused to adopt fresh main-store OAuth credential: identity mismatch", {
						profileId: params.profileId,
						agentDir: params.agentDir
					});
				} catch (err) {
					log.debug("inside-lock main-store adoption failed; proceeding to refresh", {
						profileId: params.profileId,
						error: formatErrorMessage(err)
					});
				}
				const externallyManaged = adapter.readBootstrapCredential({
					profileId: params.profileId,
					credential: cred
				});
				if (externallyManaged) if (externallyManaged.provider !== cred.provider) log.warn("refused external oauth bootstrap credential: provider mismatch", {
					profileId: params.profileId,
					provider: cred.provider
				});
				else if (!isSafeToAdoptBootstrapOAuthIdentity(cred, externallyManaged)) log.warn("refused external oauth bootstrap credential: identity mismatch or missing binding", {
					profileId: params.profileId,
					provider: cred.provider
				});
				else {
					if (shouldReplaceStoredOAuthCredential(cred, externallyManaged) && !areOAuthCredentialsEquivalent(cred, externallyManaged)) {
						store.profiles[params.profileId] = { ...externallyManaged };
						saveAuthProfileStore(store, ownerAgentDir);
					}
					credentialToRefresh = externallyManaged;
					if (!params.forceRefresh && hasUsableOAuthCredential(externallyManaged)) return {
						apiKey: await adapter.buildApiKey(externallyManaged.provider, externallyManaged, {
							cfg: params.cfg,
							agentDir: params.agentDir
						}),
						credential: externallyManaged
					};
				}
				if (normalizeSecretInputString(credentialToRefresh.refresh) === void 0) return null;
				const refreshedCredentials = await withRefreshCallTimeout(`refreshOAuthCredential(${cred.provider})`, OAUTH_REFRESH_CALL_TIMEOUT_MS, async () => {
					params.attemptedCredentials?.push(credentialToRefresh);
					const refreshed = await adapter.refreshCredential(credentialToRefresh);
					return refreshed ? {
						...credentialToRefresh,
						...refreshed,
						type: "oauth"
					} : null;
				});
				if (!refreshedCredentials) return null;
				store.profiles[params.profileId] = refreshedCredentials;
				saveAuthProfileStore(store, ownerAgentDir);
				if (ownerAgentDir) {
					if (resolveAuthStorePath(void 0) !== authPath) await mirrorRefreshedCredentialIntoMainStore({
						profileId: params.profileId,
						refreshed: refreshedCredentials
					});
				}
				return {
					apiKey: await adapter.buildApiKey(cred.provider, refreshedCredentials, {
						cfg: params.cfg,
						agentDir: params.agentDir
					}),
					credential: refreshedCredentials
				};
			}));
		} catch (error) {
			if (isGlobalRefreshLockTimeoutError(error, globalRefreshLockPath)) throw buildRefreshContentionError({
				provider: params.provider,
				profileId: params.profileId,
				cause: error
			});
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
		} finally {
			release();
			if (refreshQueues.get(key) === gate) refreshQueues.delete(key);
		}
	}
	async function resolveOAuthAccess(params) {
		const adoptedCredential = adoptNewerMainOAuthCredential({
			store: params.store,
			profileId: params.profileId,
			agentDir: params.agentDir,
			credential: params.credential
		}) ?? params.credential;
		const effectiveCredential = resolveEffectiveOAuthCredential({
			profileId: params.profileId,
			credential: adoptedCredential,
			readBootstrapCredential: adapter.readBootstrapCredential
		});
		const attemptedCredentials = [];
		if (!params.forceRefresh && hasUsableOAuthCredential(effectiveCredential)) return {
			apiKey: await adapter.buildApiKey(effectiveCredential.provider, effectiveCredential, {
				cfg: params.cfg,
				agentDir: params.agentDir
			}),
			credential: effectiveCredential
		};
		try {
			return await refreshOAuthTokenWithLock({
				profileId: params.profileId,
				provider: params.credential.provider,
				agentDir: params.agentDir,
				cfg: params.cfg,
				forceRefresh: params.forceRefresh,
				attemptedCredentials
			});
		} catch (error) {
			const refreshedStore = loadStoredOAuthRefreshStore(params.agentDir);
			const refreshed = refreshedStore.profiles[params.profileId];
			if (refreshed?.type === "oauth" && hasUsableOAuthCredential(refreshed) && canReuseOAuthCredentialAfterRefreshFailure({
				forceRefresh: params.forceRefresh,
				attempted: effectiveCredential,
				candidate: refreshed
			})) return {
				apiKey: await adapter.buildApiKey(refreshed.provider, refreshed, {
					cfg: params.cfg,
					agentDir: params.agentDir
				}),
				credential: refreshed
			};
			if (adapter.isRefreshTokenReusedError(error) && refreshed?.type === "oauth" && refreshed.provider === params.credential.provider && hasOAuthCredentialChanged(params.credential, refreshed)) {
				const recovered = await loadFreshStoredOAuthCredential({
					profileId: params.profileId,
					agentDir: params.agentDir,
					provider: params.credential.provider,
					previous: effectiveCredential,
					requireChange: true
				});
				if (recovered) return {
					apiKey: await adapter.buildApiKey(recovered.provider, recovered, {
						cfg: params.cfg,
						agentDir: params.agentDir
					}),
					credential: recovered
				};
				try {
					const retried = await refreshOAuthTokenWithLock({
						profileId: params.profileId,
						provider: params.credential.provider,
						agentDir: params.agentDir,
						cfg: params.cfg,
						forceRefresh: params.forceRefresh,
						attemptedCredentials
					});
					if (retried) return retried;
				} catch {}
			}
			if (params.agentDir) try {
				const mainCred = ensureAuthProfileStoreWithoutExternalProfiles(void 0, { allowKeychainPrompt: false }).profiles[params.profileId];
				if (mainCred?.type === "oauth" && mainCred.provider === params.credential.provider && hasUsableOAuthCredential(mainCred) && canReuseOAuthCredentialAfterRefreshFailure({
					forceRefresh: params.forceRefresh,
					attempted: effectiveCredential,
					candidate: mainCred
				}) && isSafeToAdoptMainStoreOAuthIdentity(params.credential, mainCred)) {
					refreshedStore.profiles[params.profileId] = { ...mainCred };
					log.info("inherited fresh OAuth credentials from main agent", {
						profileId: params.profileId,
						agentDir: params.agentDir,
						expires: new Date(mainCred.expires).toISOString()
					});
					return {
						apiKey: await adapter.buildApiKey(mainCred.provider, mainCred, {
							cfg: params.cfg,
							agentDir: params.agentDir
						}),
						credential: mainCred
					};
				}
			} catch {}
			const fallback = adapter.readFallbackCredential?.({
				profileId: params.profileId,
				credential: effectiveCredential
			});
			if (fallback && fallback.provider === params.credential.provider && hasUsableOAuthCredential(fallback) && hasMatchingOAuthIdentity(params.credential, fallback) && canReuseOAuthCredentialAfterRefreshFailure({
				forceRefresh: params.forceRefresh,
				attempted: effectiveCredential,
				candidate: fallback
			})) {
				log.info("using external OAuth credential after refresh failure", {
					profileId: params.profileId,
					provider: fallback.provider,
					expires: new Date(fallback.expires).toISOString()
				});
				return {
					apiKey: await adapter.buildApiKey(fallback.provider, fallback, {
						cfg: params.cfg,
						agentDir: params.agentDir
					}),
					credential: fallback
				};
			}
			throw new OAuthManagerRefreshError({
				credential: params.credential,
				attemptedCredentials: [effectiveCredential, ...attemptedCredentials],
				profileId: params.profileId,
				refreshedStore,
				cause: error
			});
		}
	}
	function resetRefreshQueuesForTest() {
		refreshQueues.clear();
	}
	return {
		resolveOAuthAccess,
		resetRefreshQueuesForTest
	};
}
//#endregion
//#region src/agents/auth-profiles/oauth.ts
function listOAuthProviderIds() {
	if (typeof getOAuthProviders !== "function") return [];
	const providers = getOAuthProviders();
	if (!Array.isArray(providers)) return [];
	return providers.map((provider) => provider && typeof provider === "object" && "id" in provider && typeof provider.id === "string" ? provider.id : void 0).filter((providerId) => typeof providerId === "string");
}
const OAUTH_PROVIDER_IDS = new Set(listOAuthProviderIds());
const isOAuthProvider = (provider) => OAUTH_PROVIDER_IDS.has(provider);
const resolveOAuthProvider = (provider) => isOAuthProvider(provider) ? provider : null;
/** Bearer-token auth modes that are interchangeable (oauth tokens and raw tokens). */
const BEARER_AUTH_MODES = new Set(["oauth", "token"]);
const isCompatibleModeType = (mode, type) => {
	if (!mode || !type) return false;
	if (mode === type) return true;
	return BEARER_AUTH_MODES.has(mode) && BEARER_AUTH_MODES.has(type);
};
function isProfileConfigCompatible(params) {
	const profileConfig = params.cfg?.auth?.profiles?.[params.profileId];
	if (profileConfig && profileConfig.provider !== params.provider) return false;
	if (profileConfig && !isCompatibleModeType(profileConfig.mode, params.mode)) return false;
	return true;
}
async function buildOAuthApiKey(provider, credentials, context) {
	const formatted = await formatProviderAuthProfileApiKeyWithPlugin({
		provider,
		config: context.cfg,
		context: credentials
	});
	return typeof formatted === "string" && formatted.length > 0 ? formatted : credentials.access;
}
function buildApiKeyProfileResult(params) {
	const result = {
		apiKey: params.apiKey,
		provider: params.provider,
		email: params.email
	};
	Object.defineProperties(result, {
		profileId: {
			value: params.profileId,
			enumerable: false
		},
		profileType: {
			value: params.profileType,
			enumerable: false
		}
	});
	return result;
}
function extractErrorMessage(error) {
	return formatErrorMessage(error);
}
function isRefreshTokenReusedError(error) {
	const message = normalizeLowercaseStringOrEmpty(extractErrorMessage(error));
	return message.includes("refresh_token_reused") || message.includes("refresh token has already been used") || message.includes("already been used to generate a new access token");
}
async function refreshOAuthCredential(credential) {
	const pluginRefreshed = await refreshProviderOAuthCredentialWithPlugin({
		provider: credential.provider,
		context: credential
	});
	if (pluginRefreshed) return pluginRefreshed;
	if (credential.provider === "chutes") return await refreshChutesTokens({ credential });
	const oauthProvider = resolveOAuthProvider(credential.provider);
	if (!oauthProvider || typeof getOAuthApiKey !== "function") return null;
	return (await getOAuthApiKey(oauthProvider, { [credential.provider]: credential }))?.newCredentials ?? null;
}
async function refreshOAuthCredentialForRuntime(params) {
	const refreshed = await refreshOAuthCredential(params.credential);
	return refreshed ? {
		...params.credential,
		...refreshed,
		type: "oauth"
	} : null;
}
const oauthManager = createOAuthManager({
	buildApiKey: buildOAuthApiKey,
	refreshCredential: refreshOAuthCredential,
	readBootstrapCredential: ({ profileId, credential }) => readManagedExternalCliCredential({
		profileId,
		credential
	}),
	readFallbackCredential: ({ profileId, credential }) => credential.provider === "openai-codex" ? readExternalCliFallbackCredential({
		profileId,
		credential,
		allowKeychainPrompt: false
	}) : null,
	isRefreshTokenReusedError
});
async function tryResolveOAuthProfile(params) {
	const { cfg, store, profileId } = params;
	const cred = store.profiles[profileId];
	if (!cred || cred.type !== "oauth") return null;
	if (!isProfileConfigCompatible({
		cfg,
		profileId,
		provider: cred.provider,
		mode: cred.type
	})) return null;
	const resolved = await oauthManager.resolveOAuthAccess({
		store,
		profileId,
		credential: cred,
		agentDir: params.agentDir,
		cfg,
		forceRefresh: params.forceRefresh
	});
	if (!resolved) return null;
	return buildApiKeyProfileResult({
		apiKey: resolved.apiKey,
		provider: resolved.credential.provider,
		email: resolved.credential.email ?? cred.email,
		profileId,
		profileType: cred.type
	});
}
async function resolveProfileSecretString(params) {
	let resolvedValue = params.value?.trim();
	if (resolvedValue) {
		const inlineRef = coerceSecretRef(resolvedValue, params.refDefaults);
		if (inlineRef) try {
			resolvedValue = await resolveSecretRefString(inlineRef, {
				config: params.configForRefResolution,
				env: process.env,
				cache: params.cache
			});
		} catch (err) {
			log.debug(params.inlineFailureMessage, {
				profileId: params.profileId,
				provider: params.provider,
				error: formatErrorMessage(err)
			});
		}
	}
	const explicitRef = coerceSecretRef(params.valueRef, params.refDefaults);
	if (!resolvedValue && explicitRef) try {
		resolvedValue = await resolveSecretRefString(explicitRef, {
			config: params.configForRefResolution,
			env: process.env,
			cache: params.cache
		});
	} catch (err) {
		log.debug(params.refFailureMessage, {
			profileId: params.profileId,
			provider: params.provider,
			error: formatErrorMessage(err)
		});
	}
	return normalizeOptionalSecretInput(resolvedValue);
}
async function resolveApiKeyForProfile(params) {
	const { cfg, store, profileId } = params;
	const cred = store.profiles[profileId];
	if (!cred) return null;
	if (!isProfileConfigCompatible({
		cfg,
		profileId,
		provider: cred.provider,
		mode: cred.type,
		allowOAuthTokenCompatibility: true
	})) return null;
	const refResolveCache = {};
	const configForRefResolution = cfg ?? getRuntimeConfig();
	const refDefaults = configForRefResolution.secrets?.defaults;
	assertNoOAuthSecretRefPolicyViolations({
		store,
		cfg: configForRefResolution,
		profileIds: [profileId],
		context: `auth profile ${profileId}`
	});
	if (cred.type === "api_key") {
		const key = await resolveProfileSecretString({
			profileId,
			provider: cred.provider,
			value: cred.key,
			valueRef: cred.keyRef,
			refDefaults,
			configForRefResolution,
			cache: refResolveCache,
			inlineFailureMessage: "failed to resolve inline auth profile api_key ref",
			refFailureMessage: "failed to resolve auth profile api_key ref"
		});
		if (!key) return null;
		return buildApiKeyProfileResult({
			apiKey: key,
			provider: cred.provider,
			email: cred.email,
			profileId,
			profileType: cred.type
		});
	}
	if (cred.type === "token") {
		const expiryState = resolveTokenExpiryState(cred.expires);
		if (expiryState === "expired" || expiryState === "invalid_expires") return null;
		const token = await resolveProfileSecretString({
			profileId,
			provider: cred.provider,
			value: cred.token,
			valueRef: cred.tokenRef,
			refDefaults,
			configForRefResolution,
			cache: refResolveCache,
			inlineFailureMessage: "failed to resolve inline auth profile token ref",
			refFailureMessage: "failed to resolve auth profile token ref"
		});
		if (!token) return null;
		return buildApiKeyProfileResult({
			apiKey: token,
			provider: cred.provider,
			email: cred.email,
			profileId,
			profileType: cred.type
		});
	}
	try {
		const resolved = await oauthManager.resolveOAuthAccess({
			store,
			agentDir: params.agentDir,
			profileId,
			credential: cred,
			cfg,
			forceRefresh: params.forceRefresh
		});
		if (!resolved) return null;
		return buildApiKeyProfileResult({
			apiKey: resolved.apiKey,
			provider: resolved.credential.provider,
			email: resolved.credential.email ?? cred.email,
			profileId,
			profileType: cred.type
		});
	} catch (error) {
		let refreshedStore = error instanceof OAuthManagerRefreshError ? error.getRefreshedStore() : loadAuthProfileStoreForSecretsRuntime(params.agentDir);
		const surfacedCause = error instanceof OAuthManagerRefreshError && error.cause ? error.cause : error;
		const surfacedMessageError = error instanceof OAuthManagerRefreshError && error.code === "refresh_contention" ? error : surfacedCause;
		if (isRefreshTokenReusedError(surfacedCause)) {
			const ownerAgentDir = resolvePersistedAuthProfileOwnerAgentDir({
				agentDir: params.agentDir,
				profileId
			});
			await clearLastGoodProfileWithLock({
				provider: cred.provider,
				profileId,
				agentDir: ownerAgentDir
			});
			if (params.agentDir !== ownerAgentDir && hasRuntimeAuthProfileStoreSnapshot(params.agentDir)) {
				const snapshot = getRuntimeAuthProfileStoreSnapshot(params.agentDir);
				const providerKey = resolveProviderIdForAuth(cred.provider);
				if (snapshot?.lastGood?.[providerKey] === profileId) {
					delete snapshot.lastGood[providerKey];
					if (Object.keys(snapshot.lastGood).length === 0) snapshot.lastGood = void 0;
					setRuntimeAuthProfileStoreSnapshot(snapshot, params.agentDir);
				}
			}
			refreshedStore = loadAuthProfileStoreForSecretsRuntime(params.agentDir);
		}
		const fallbackProfileId = suggestOAuthProfileIdForLegacyDefault({
			cfg,
			store: refreshedStore,
			provider: cred.provider,
			legacyProfileId: profileId
		});
		if (fallbackProfileId && fallbackProfileId !== profileId) try {
			const fallbackResolved = await tryResolveOAuthProfile({
				cfg,
				store: refreshedStore,
				profileId: fallbackProfileId,
				agentDir: params.agentDir,
				forceRefresh: params.forceRefresh
			});
			if (fallbackResolved) return fallbackResolved;
		} catch {}
		const message = extractErrorMessage(surfacedMessageError);
		const hint = await formatAuthDoctorHint({
			cfg,
			store: refreshedStore,
			provider: cred.provider,
			profileId
		});
		throw new Error(`OAuth token refresh failed for ${cred.provider}: ${message}. Please try again or re-authenticate.` + (hint ? `\n\n${hint}` : ""), { cause: error });
	}
}
//#endregion
export { formatAuthDoctorHint as i, resolveApiKeyForProfile as n, resolveEffectiveOAuthCredential as r, refreshOAuthCredentialForRuntime as t };
