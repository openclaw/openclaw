import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { _ as resolveOAuthDir, v as resolveOAuthPath, y as resolveStateDir } from "./paths-Cw7f9XhU.js";
import "./errors-b3ZrCRlt.js";
import { p as resolveUserPath } from "./utils-sBTEdeml.js";
import { d as normalizeSecretInputString, o as coerceSecretRef } from "./types.secrets-DwPik3M8.js";
import { r as normalizeProviderId } from "./provider-id-zTW9Rdln.js";
import { n as saveJsonFile, t as loadJsonFile } from "./json-file-DpLhTVdZ.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { o as withFileLock } from "./file-lock-D5OTq3qW.js";
import "./file-lock-BSRN56ID.js";
import { a as replaceRuntimeAuthProfileStoreSnapshots$1, i as hasRuntimeAuthProfileStoreSnapshot, n as getRuntimeAuthProfileStoreSnapshot, o as setRuntimeAuthProfileStoreSnapshot, s as cloneAuthProfileStore, t as clearRuntimeAuthProfileStoreSnapshots$1 } from "./runtime-snapshots-esDr_mQ_.js";
import { a as resolveLegacyAuthStorePath, r as resolveAuthStorePath, t as resolveAuthStatePath } from "./path-resolve-C6Vj5eOM.js";
import { a as MINIMAX_CLI_PROFILE_ID, c as OPENAI_CODEX_DEFAULT_PROFILE_ID, i as EXTERNAL_CLI_SYNC_TTL_MS, l as log$1, n as CLAUDE_CLI_PROFILE_ID, t as AUTH_STORE_LOCK_OPTIONS } from "./constants-D_82oc2f.js";
import { S as resolveExternalAuthProfilesWithPlugins } from "./provider-runtime-D8jQEgmu.js";
import { t as ensureAuthStoreFile } from "./paths-DuwII6c5.js";
import { n as readCachedAuthProfileStore, r as writeCachedAuthProfileStore, t as clearLoadedAuthStoreCache } from "./store-cache-BnGl6Zb-.js";
import "./source-check-BMw3fGLx.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import * as childProcess from "node:child_process";
import { execSync } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
//#region src/agents/cli-credentials.ts
const log = createSubsystemLogger("agents/auth-profiles");
const CLAUDE_CLI_CREDENTIALS_RELATIVE_PATH = ".claude/.credentials.json";
const CODEX_CLI_AUTH_FILENAME = "auth.json";
const MINIMAX_CLI_CREDENTIALS_RELATIVE_PATH = ".minimax/oauth_creds.json";
const GEMINI_CLI_CREDENTIALS_RELATIVE_PATH = ".gemini/oauth_creds.json";
const CLAUDE_CLI_KEYCHAIN_SERVICE = "Claude Code-credentials";
let claudeCliCache = null;
let codexCliCache = null;
let minimaxCliCache = null;
let geminiCliCache = null;
function resolveClaudeCliCredentialsPath(homeDir) {
	const baseDir = homeDir ?? resolveUserPath("~");
	return path.join(baseDir, CLAUDE_CLI_CREDENTIALS_RELATIVE_PATH);
}
function parseClaudeCliOauthCredential(claudeOauth) {
	if (!claudeOauth || typeof claudeOauth !== "object") return null;
	const accessToken = claudeOauth.accessToken;
	const refreshToken = claudeOauth.refreshToken;
	const expiresAt = claudeOauth.expiresAt;
	if (typeof accessToken !== "string" || !accessToken) return null;
	if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt) || expiresAt <= 0) return null;
	if (typeof refreshToken === "string" && refreshToken) return {
		type: "oauth",
		provider: "anthropic",
		access: accessToken,
		refresh: refreshToken,
		expires: expiresAt
	};
	return {
		type: "token",
		provider: "anthropic",
		token: accessToken,
		expires: expiresAt
	};
}
function resolveCodexHomePath(codexHome) {
	const configured = codexHome ?? process.env.CODEX_HOME;
	const home = configured ? resolveUserPath(configured) : resolveUserPath("~/.codex");
	try {
		return fs.realpathSync.native(home);
	} catch {
		return home;
	}
}
function resolveMiniMaxCliCredentialsPath(homeDir) {
	const baseDir = homeDir ?? resolveUserPath("~");
	return path.join(baseDir, MINIMAX_CLI_CREDENTIALS_RELATIVE_PATH);
}
function resolveGeminiCliCredentialsPath(homeDir) {
	const baseDir = homeDir ?? resolveUserPath("~");
	return path.join(baseDir, GEMINI_CLI_CREDENTIALS_RELATIVE_PATH);
}
function readFileMtimeMs(filePath) {
	try {
		return fs.statSync(filePath).mtimeMs;
	} catch {
		return null;
	}
}
function readCachedCliCredential(options) {
	const { ttlMs, cache, cacheKey, read, setCache, readSourceFingerprint } = options;
	if (ttlMs <= 0) return read();
	const now = Date.now();
	const sourceFingerprint = readSourceFingerprint?.();
	if (cache && cache.cacheKey === cacheKey && cache.sourceFingerprint === sourceFingerprint && now - cache.readAt < ttlMs) return cache.value;
	const value = read();
	const cachedSourceFingerprint = readSourceFingerprint?.();
	if (!readSourceFingerprint || cachedSourceFingerprint === sourceFingerprint) setCache({
		value,
		readAt: now,
		cacheKey,
		sourceFingerprint: cachedSourceFingerprint
	});
	else setCache(null);
	return value;
}
function computeCodexKeychainAccount(codexHome) {
	return `cli|${createHash("sha256").update(codexHome).digest("hex").slice(0, 16)}`;
}
function resolveCodexKeychainParams(options) {
	return {
		platform: options?.platform ?? process.platform,
		execSyncImpl: options?.execSync ?? execSync,
		codexHome: resolveCodexHomePath(options?.codexHome)
	};
}
function decodeJwtExpiryMs(token) {
	const parts = token.split(".");
	if (parts.length < 2) return null;
	try {
		const payloadRaw = Buffer.from(parts[1], "base64url").toString("utf8");
		const payload = JSON.parse(payloadRaw);
		return typeof payload.exp === "number" && Number.isFinite(payload.exp) && payload.exp > 0 ? payload.exp * 1e3 : null;
	} catch {
		return null;
	}
}
function decodeJwtIdentityClaims(token) {
	const parts = token.split(".");
	if (parts.length < 2) return {};
	try {
		const payloadRaw = Buffer.from(parts[1], "base64url").toString("utf8");
		const payload = JSON.parse(payloadRaw);
		return {
			sub: typeof payload.sub === "string" && payload.sub ? payload.sub : void 0,
			email: typeof payload.email === "string" && payload.email ? payload.email : void 0
		};
	} catch {
		return {};
	}
}
function readCodexKeychainAuthRecord(options) {
	const { platform, execSyncImpl, codexHome } = resolveCodexKeychainParams(options);
	if (platform !== "darwin" || options?.allowKeychainPrompt === false) return null;
	const account = computeCodexKeychainAccount(codexHome);
	try {
		const secret = execSyncImpl(`security find-generic-password -s "Codex Auth" -a "${account}" -w`, {
			encoding: "utf8",
			timeout: 5e3,
			stdio: [
				"pipe",
				"pipe",
				"pipe"
			]
		}).trim();
		return JSON.parse(secret);
	} catch {
		return null;
	}
}
function readCodexKeychainCredentials(options) {
	const parsed = readCodexKeychainAuthRecord(options);
	if (!parsed) return null;
	const tokens = parsed.tokens;
	try {
		const accessToken = tokens?.access_token;
		const refreshToken = tokens?.refresh_token;
		if (typeof accessToken !== "string" || !accessToken) return null;
		if (typeof refreshToken !== "string" || !refreshToken) return null;
		const lastRefreshRaw = parsed.last_refresh;
		const lastRefresh = typeof lastRefreshRaw === "string" || typeof lastRefreshRaw === "number" ? new Date(lastRefreshRaw).getTime() : Date.now();
		const fallbackExpiry = Number.isFinite(lastRefresh) ? lastRefresh + 3600 * 1e3 : Date.now() + 3600 * 1e3;
		const expires = decodeJwtExpiryMs(accessToken) ?? fallbackExpiry;
		const accountId = typeof tokens?.account_id === "string" ? tokens.account_id : void 0;
		const idToken = typeof tokens?.id_token === "string" ? tokens.id_token : void 0;
		log.info("read codex credentials from keychain", {
			source: "keychain",
			expires: new Date(expires).toISOString()
		});
		return {
			type: "oauth",
			provider: "openai-codex",
			access: accessToken,
			refresh: refreshToken,
			expires,
			accountId,
			idToken
		};
	} catch {
		return null;
	}
}
function readPortalCliOauthCredentials(credPath, provider) {
	const raw = loadJsonFile(credPath);
	if (!raw || typeof raw !== "object") return null;
	const data = raw;
	const accessToken = data.access_token;
	const refreshToken = data.refresh_token;
	const expiresAt = data.expiry_date;
	if (typeof accessToken !== "string" || !accessToken) return null;
	if (typeof refreshToken !== "string" || !refreshToken) return null;
	if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return null;
	return {
		type: "oauth",
		provider,
		access: accessToken,
		refresh: refreshToken,
		expires: expiresAt
	};
}
function readMiniMaxCliCredentials(options) {
	return readPortalCliOauthCredentials(resolveMiniMaxCliCredentialsPath(options?.homeDir), "minimax-portal");
}
function readGeminiCliCredentials(options) {
	const raw = loadJsonFile(resolveGeminiCliCredentialsPath(options?.homeDir));
	if (!raw || typeof raw !== "object") return null;
	const data = raw;
	const accessToken = data.access_token;
	const refreshToken = data.refresh_token;
	const expiresAt = data.expiry_date;
	if (typeof accessToken !== "string" || !accessToken) return null;
	if (typeof refreshToken !== "string" || !refreshToken) return null;
	if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return null;
	const idTokenRaw = data.id_token;
	const identity = typeof idTokenRaw === "string" && idTokenRaw ? decodeJwtIdentityClaims(idTokenRaw) : {};
	return {
		type: "oauth",
		provider: "google-gemini-cli",
		access: accessToken,
		refresh: refreshToken,
		expires: expiresAt,
		...identity.email ? { email: identity.email } : {},
		...identity.sub ? { accountId: identity.sub } : {}
	};
}
function readClaudeCliKeychainCredentials(execSyncImpl = execSync) {
	try {
		const result = execSyncImpl(`security find-generic-password -s "${CLAUDE_CLI_KEYCHAIN_SERVICE}" -w`, {
			encoding: "utf8",
			timeout: 5e3,
			stdio: [
				"pipe",
				"pipe",
				"pipe"
			]
		});
		return parseClaudeCliOauthCredential(JSON.parse(result.trim())?.claudeAiOauth);
	} catch {
		return null;
	}
}
function readClaudeCliCredentials(options) {
	if ((options?.platform ?? process.platform) === "darwin" && options?.allowKeychainPrompt !== false) {
		const keychainCreds = readClaudeCliKeychainCredentials(options?.execSync);
		if (keychainCreds) {
			log.info("read anthropic credentials from claude cli keychain", { type: keychainCreds.type });
			return keychainCreds;
		}
	}
	const raw = loadJsonFile(resolveClaudeCliCredentialsPath(options?.homeDir));
	if (!raw || typeof raw !== "object") return null;
	return parseClaudeCliOauthCredential(raw.claudeAiOauth);
}
/** @deprecated Anthropic provider-owned CLI credential helper; do not use from third-party plugins. */
function readClaudeCliCredentialsCached(options) {
	const platform = options?.platform ?? process.platform;
	const ttlMs = options?.ttlMs ?? 0;
	const credentialsPath = resolveClaudeCliCredentialsPath(options?.homeDir);
	const keychainIntent = platform === "darwin" && options?.allowKeychainPrompt !== false ? "keychain" : "file";
	return readCachedCliCredential({
		ttlMs,
		cache: claudeCliCache,
		cacheKey: `${credentialsPath}:${keychainIntent}`,
		read: () => readClaudeCliCredentials({
			allowKeychainPrompt: options?.allowKeychainPrompt,
			platform,
			homeDir: options?.homeDir,
			execSync: options?.execSync
		}),
		setCache: (next) => {
			claudeCliCache = next;
		}
	});
}
function readCodexCliCredentials(options) {
	const keychain = readCodexKeychainCredentials({
		codexHome: options?.codexHome,
		allowKeychainPrompt: options?.allowKeychainPrompt,
		platform: options?.platform,
		execSync: options?.execSync
	});
	if (keychain) return keychain;
	const authPath = path.join(resolveCodexHomePath(options?.codexHome), CODEX_CLI_AUTH_FILENAME);
	const raw = loadJsonFile(authPath);
	if (!raw || typeof raw !== "object") return null;
	const tokens = raw.tokens;
	if (!tokens || typeof tokens !== "object") return null;
	const accessToken = tokens.access_token;
	const refreshToken = tokens.refresh_token;
	if (typeof accessToken !== "string" || !accessToken) return null;
	if (typeof refreshToken !== "string" || !refreshToken) return null;
	let fallbackExpiry;
	try {
		fallbackExpiry = fs.statSync(authPath).mtimeMs + 3600 * 1e3;
	} catch {
		fallbackExpiry = Date.now() + 3600 * 1e3;
	}
	return {
		type: "oauth",
		provider: "openai-codex",
		access: accessToken,
		refresh: refreshToken,
		expires: decodeJwtExpiryMs(accessToken) ?? fallbackExpiry,
		accountId: typeof tokens.account_id === "string" ? tokens.account_id : void 0,
		idToken: typeof tokens.id_token === "string" ? tokens.id_token : void 0
	};
}
function readCodexCliCredentialsCached(options) {
	const platform = options?.platform ?? process.platform;
	const ttlMs = options?.ttlMs ?? 0;
	const authPath = path.join(resolveCodexHomePath(options?.codexHome), CODEX_CLI_AUTH_FILENAME);
	const keychainIntent = platform === "darwin" && options?.allowKeychainPrompt !== false ? "keychain" : "file";
	return readCachedCliCredential({
		ttlMs,
		cache: codexCliCache,
		cacheKey: `${platform}|${authPath}:${keychainIntent}`,
		read: () => readCodexCliCredentials({
			codexHome: options?.codexHome,
			allowKeychainPrompt: options?.allowKeychainPrompt,
			platform: options?.platform,
			execSync: options?.execSync
		}),
		setCache: (next) => {
			codexCliCache = next;
		},
		readSourceFingerprint: () => readFileMtimeMs(authPath)
	});
}
function readMiniMaxCliCredentialsCached(options) {
	const credPath = resolveMiniMaxCliCredentialsPath(options?.homeDir);
	return readCachedCliCredential({
		ttlMs: options?.ttlMs ?? 0,
		cache: minimaxCliCache,
		cacheKey: credPath,
		read: () => readMiniMaxCliCredentials({ homeDir: options?.homeDir }),
		setCache: (next) => {
			minimaxCliCache = next;
		},
		readSourceFingerprint: () => readFileMtimeMs(credPath)
	});
}
function readGeminiCliCredentialsCached(options) {
	const credPath = resolveGeminiCliCredentialsPath(options?.homeDir);
	return readCachedCliCredential({
		ttlMs: options?.ttlMs ?? 0,
		cache: geminiCliCache,
		cacheKey: credPath,
		read: () => readGeminiCliCredentials({ homeDir: options?.homeDir }),
		setCache: (next) => {
			geminiCliCache = next;
		},
		readSourceFingerprint: () => readFileMtimeMs(credPath)
	});
}
//#endregion
//#region src/agents/auth-profiles/credential-state.ts
const DEFAULT_OAUTH_REFRESH_MARGIN_MS = 300 * 1e3;
function resolveTokenExpiryState(expires, now = Date.now(), opts) {
	if (expires === void 0) return "missing";
	if (typeof expires !== "number") return "invalid_expires";
	if (!Number.isFinite(expires) || expires <= 0) return "invalid_expires";
	const remainingMs = expires - now;
	if (remainingMs <= 0) return "expired";
	const expiringWithinMs = Math.max(0, opts?.expiringWithinMs ?? 0);
	if (expiringWithinMs > 0 && remainingMs <= expiringWithinMs) return "expiring";
	return "valid";
}
function hasUsableOAuthCredential$1(credential, opts) {
	if (!credential || credential.type !== "oauth") return false;
	if (typeof credential.access !== "string" || credential.access.trim().length === 0) return false;
	const now = opts?.now ?? Date.now();
	const refreshMarginMs = Math.max(0, opts?.refreshMarginMs ?? 3e5);
	return resolveTokenExpiryState(credential.expires, now, { expiringWithinMs: refreshMarginMs }) === "valid";
}
function hasConfiguredSecretRef(value) {
	return coerceSecretRef(value) !== null;
}
function hasConfiguredSecretString(value) {
	return normalizeSecretInputString(value) !== void 0;
}
function evaluateStoredCredentialEligibility(params) {
	const now = params.now ?? Date.now();
	const credential = params.credential;
	if (credential.type === "api_key") {
		const hasKey = hasConfiguredSecretString(credential.key);
		const hasKeyRef = hasConfiguredSecretRef(credential.keyRef);
		if (!hasKey && !hasKeyRef) return {
			eligible: false,
			reasonCode: "missing_credential"
		};
		return {
			eligible: true,
			reasonCode: "ok"
		};
	}
	if (credential.type === "token") {
		const hasToken = hasConfiguredSecretString(credential.token);
		const hasTokenRef = hasConfiguredSecretRef(credential.tokenRef);
		if (!hasToken && !hasTokenRef) return {
			eligible: false,
			reasonCode: "missing_credential"
		};
		const expiryState = resolveTokenExpiryState(credential.expires, now);
		if (expiryState === "invalid_expires") return {
			eligible: false,
			reasonCode: "invalid_expires"
		};
		if (expiryState === "expired") return {
			eligible: false,
			reasonCode: "expired"
		};
		return {
			eligible: true,
			reasonCode: "ok"
		};
	}
	if (normalizeSecretInputString(credential.access) === void 0 && normalizeSecretInputString(credential.refresh) === void 0) return {
		eligible: false,
		reasonCode: "missing_credential"
	};
	return {
		eligible: true,
		reasonCode: "ok"
	};
}
//#endregion
//#region src/agents/auth-profiles/oauth-shared.ts
function areOAuthCredentialsEquivalent(a, b) {
	if (!a || a.type !== "oauth") return false;
	return a.provider === b.provider && a.access === b.access && a.refresh === b.refresh && a.expires === b.expires && a.email === b.email && a.enterpriseUrl === b.enterpriseUrl && a.projectId === b.projectId && a.accountId === b.accountId && a.idToken === b.idToken;
}
function hasNewerStoredOAuthCredential(existing, incoming) {
	return Boolean(existing && existing.provider === incoming.provider && Number.isFinite(existing.expires) && (!Number.isFinite(incoming.expires) || existing.expires > incoming.expires));
}
function shouldReplaceStoredOAuthCredential(existing, incoming) {
	if (!existing || existing.type !== "oauth") return true;
	if (areOAuthCredentialsEquivalent(existing, incoming)) return false;
	return !hasNewerStoredOAuthCredential(existing, incoming);
}
function hasUsableOAuthCredential(credential, now = Date.now()) {
	return hasUsableOAuthCredential$1(credential, { now });
}
function normalizeAuthIdentityToken$1(value) {
	const trimmed = value?.trim();
	return trimmed ? trimmed : void 0;
}
function normalizeAuthEmailToken$1(value) {
	return normalizeAuthIdentityToken$1(value)?.toLowerCase();
}
function hasOAuthIdentity(credential) {
	return normalizeAuthIdentityToken$1(credential.accountId) !== void 0 || normalizeAuthEmailToken$1(credential.email) !== void 0;
}
function hasMatchingOAuthIdentity(existing, incoming) {
	const existingAccountId = normalizeAuthIdentityToken$1(existing.accountId);
	const incomingAccountId = normalizeAuthIdentityToken$1(incoming.accountId);
	if (existingAccountId !== void 0 && incomingAccountId !== void 0) return existingAccountId === incomingAccountId;
	const existingEmail = normalizeAuthEmailToken$1(existing.email);
	const incomingEmail = normalizeAuthEmailToken$1(incoming.email);
	if (existingEmail !== void 0 && incomingEmail !== void 0) return existingEmail === incomingEmail;
	return false;
}
function isSafeToAdoptBootstrapOAuthIdentity(existing, incoming) {
	if (!existing || existing.type !== "oauth") return true;
	if (existing.provider !== incoming.provider) return false;
	if (areOAuthCredentialsEquivalent(existing, incoming)) return true;
	if (!hasOAuthIdentity(existing)) return true;
	return hasMatchingOAuthIdentity(existing, incoming);
}
function isSafeToAdoptMainStoreOAuthIdentity(existing, incoming) {
	if (!existing || existing.type !== "oauth") return false;
	if (existing.provider !== incoming.provider) return false;
	if (areOAuthCredentialsEquivalent(existing, incoming)) return true;
	if (!hasOAuthIdentity(existing)) return true;
	return hasMatchingOAuthIdentity(existing, incoming);
}
function shouldBootstrapFromExternalCliCredential(params) {
	const now = params.now ?? Date.now();
	if (hasUsableOAuthCredential(params.existing, now)) return false;
	return hasUsableOAuthCredential(params.imported, now);
}
function overlayRuntimeExternalOAuthProfiles(store, profiles) {
	const externalProfiles = Array.from(profiles);
	if (externalProfiles.length === 0) return store;
	const next = cloneAuthProfileStore(store);
	for (const profile of externalProfiles) next.profiles[profile.profileId] = profile.credential;
	return next;
}
function shouldPersistRuntimeExternalOAuthProfile(params) {
	for (const profile of params.profiles) {
		if (profile.profileId !== params.profileId) continue;
		if (profile.persistence === "persisted") return true;
		return !areOAuthCredentialsEquivalent(profile.credential, params.credential);
	}
	return true;
}
//#endregion
//#region src/agents/auth-profiles/external-cli-sync.ts
function normalizeAuthIdentityToken(value) {
	const trimmed = value?.trim();
	return trimmed ? trimmed : void 0;
}
function normalizeAuthEmailToken(value) {
	return normalizeAuthIdentityToken(value)?.toLowerCase();
}
function isSafeToUseExternalCliCredential(existing, imported) {
	if (!existing) return true;
	if (existing.provider !== imported.provider) return false;
	const existingAccountId = normalizeAuthIdentityToken(existing.accountId);
	const importedAccountId = normalizeAuthIdentityToken(imported.accountId);
	const existingEmail = normalizeAuthEmailToken(existing.email);
	const importedEmail = normalizeAuthEmailToken(imported.email);
	if (existingAccountId !== void 0 && importedAccountId !== void 0) return existingAccountId === importedAccountId;
	if (existingEmail !== void 0 && importedEmail !== void 0) return existingEmail === importedEmail;
	if (existingAccountId !== void 0 || existingEmail !== void 0) return false;
	return true;
}
const EXTERNAL_CLI_SYNC_PROVIDERS = [
	{
		profileId: OPENAI_CODEX_DEFAULT_PROFILE_ID,
		provider: "openai-codex",
		aliases: [
			"codex",
			"codex-cli",
			"codex-app-server"
		],
		readCredentials: (options) => readCodexCliCredentialsCached({
			ttlMs: EXTERNAL_CLI_SYNC_TTL_MS,
			allowKeychainPrompt: options?.allowKeychainPrompt
		}),
		bootstrapOnly: true
	},
	{
		profileId: CLAUDE_CLI_PROFILE_ID,
		provider: "claude-cli",
		readCredentials: (options) => {
			const credential = readClaudeCliCredentialsCached({
				ttlMs: EXTERNAL_CLI_SYNC_TTL_MS,
				allowKeychainPrompt: options?.allowKeychainPrompt
			});
			if (credential?.type !== "oauth") return null;
			return {
				...credential,
				provider: "claude-cli"
			};
		}
	},
	{
		profileId: MINIMAX_CLI_PROFILE_ID,
		provider: "minimax-portal",
		aliases: ["minimax", "minimax-cli"],
		readCredentials: () => readMiniMaxCliCredentialsCached({ ttlMs: EXTERNAL_CLI_SYNC_TTL_MS })
	}
];
function resolveExternalCliSyncProvider(params) {
	const provider = EXTERNAL_CLI_SYNC_PROVIDERS.find((entry) => entry.profileId === params.profileId);
	if (!provider) return null;
	if (params.credential && provider.provider !== params.credential.provider) return null;
	return provider;
}
function hasInlineOAuthTokenMaterial$1(credential) {
	return [
		credential.access,
		credential.refresh,
		credential.idToken
	].some((value) => typeof value === "string" && value.trim().length > 0);
}
function readExternalCliBootstrapCredential(params) {
	const provider = resolveExternalCliSyncProvider(params);
	if (!provider) return null;
	if (provider.bootstrapOnly && !params.allowInlineOAuthTokenMaterial && hasInlineOAuthTokenMaterial$1(params.credential)) return null;
	return provider.readCredentials({ allowKeychainPrompt: params.allowKeychainPrompt });
}
const readManagedExternalCliCredential = readExternalCliBootstrapCredential;
function readExternalCliFallbackCredential(params) {
	const provider = resolveExternalCliSyncProvider(params) ?? EXTERNAL_CLI_SYNC_PROVIDERS.find((entry) => entry.provider === params.credential.provider);
	if (!provider) return null;
	return provider.readCredentials({ allowKeychainPrompt: params.allowKeychainPrompt });
}
function normalizeProviderScope(values) {
	if (values === void 0) return;
	const out = /* @__PURE__ */ new Set();
	for (const value of values) {
		const raw = value.trim();
		if (!raw) continue;
		out.add(raw.toLowerCase());
		const normalized = normalizeProviderId(raw);
		if (normalized) out.add(normalized);
	}
	return out;
}
function normalizeProfileScope(values) {
	if (values === void 0) return;
	const out = /* @__PURE__ */ new Set();
	for (const value of values) {
		const raw = value.trim().toLowerCase();
		if (raw) out.add(raw);
	}
	return out;
}
function isExternalCliProviderInScope(params) {
	const { providerConfig, options, store } = params;
	const providerScope = normalizeProviderScope(options?.providerIds);
	const profileScope = normalizeProfileScope(options?.profileIds);
	if (providerScope === void 0 && profileScope === void 0) {
		const existing = store.profiles[providerConfig.profileId];
		return existing?.type === "oauth" && existing.provider === providerConfig.provider;
	}
	if (profileScope?.has(providerConfig.profileId.toLowerCase())) return true;
	if (!providerScope || providerScope.size === 0) return false;
	return [providerConfig.provider, ...providerConfig.aliases ?? []].some((alias) => {
		const raw = alias.trim().toLowerCase();
		const normalized = normalizeProviderId(alias);
		return providerScope.has(raw) || (normalized ? providerScope.has(normalized) : false);
	});
}
function resolveExternalCliAuthProfiles(store, options) {
	const profiles = [];
	const now = Date.now();
	for (const providerConfig of EXTERNAL_CLI_SYNC_PROVIDERS) {
		if (!isExternalCliProviderInScope({
			providerConfig,
			store,
			options
		})) continue;
		const existing = store.profiles[providerConfig.profileId];
		const existingOAuth = existing?.type === "oauth" && existing.provider === providerConfig.provider ? existing : void 0;
		if (existing && !existingOAuth) {
			log$1.debug("kept explicit local auth over external cli bootstrap", {
				profileId: providerConfig.profileId,
				provider: providerConfig.provider,
				localType: existing.type,
				localProvider: existing.provider
			});
			continue;
		}
		if (providerConfig.bootstrapOnly && existingOAuth && hasInlineOAuthTokenMaterial$1(existingOAuth)) {
			log$1.debug("kept local oauth over external cli bootstrap-only provider", {
				profileId: providerConfig.profileId,
				provider: providerConfig.provider
			});
			continue;
		}
		if (existingOAuth && !providerConfig.bootstrapOnly && hasUsableOAuthCredential(existingOAuth, now)) continue;
		const creds = providerConfig.readCredentials({ allowKeychainPrompt: options?.allowKeychainPrompt });
		if (!creds) continue;
		if (existingOAuth && !isSafeToUseExternalCliCredential(existingOAuth, creds)) {
			log$1.warn("refused external cli oauth bootstrap: identity mismatch", {
				profileId: providerConfig.profileId,
				provider: providerConfig.provider
			});
			continue;
		}
		if (existingOAuth && !isSafeToAdoptBootstrapOAuthIdentity(existingOAuth, creds) && !areOAuthCredentialsEquivalent(existingOAuth, creds)) {
			log$1.warn("refused external cli oauth bootstrap: identity mismatch or missing binding", {
				profileId: providerConfig.profileId,
				provider: providerConfig.provider
			});
			continue;
		}
		if (!shouldBootstrapFromExternalCliCredential({
			existing: existingOAuth,
			imported: creds,
			now
		})) {
			if (existingOAuth) log$1.debug("kept usable local oauth over external cli bootstrap", {
				profileId: providerConfig.profileId,
				provider: providerConfig.provider,
				localExpires: existingOAuth.expires,
				externalExpires: creds.expires
			});
			continue;
		}
		log$1.debug("used external cli oauth bootstrap because local oauth was missing or unusable", {
			profileId: providerConfig.profileId,
			provider: providerConfig.provider,
			localExpires: existingOAuth?.expires,
			externalExpires: creds.expires
		});
		profiles.push({
			profileId: providerConfig.profileId,
			credential: creds,
			persistence: providerConfig.bootstrapOnly ? "runtime-only" : "persisted"
		});
	}
	return profiles;
}
function normalizeExternalAuthProfile(profile) {
	if (!profile?.profileId || !profile.credential) return null;
	return {
		...profile,
		persistence: profile.persistence ?? "runtime-only"
	};
}
function resolveExternalAuthProfileMap(params) {
	const env = params.env ?? process.env;
	const profiles = resolveExternalAuthProfilesWithPlugins({
		env,
		config: params.externalCli?.config,
		context: {
			config: params.externalCli?.config,
			agentDir: params.agentDir,
			workspaceDir: void 0,
			env,
			store: params.store
		}
	});
	const resolved = /* @__PURE__ */ new Map();
	const cliProfiles = resolveExternalCliAuthProfiles?.(params.store, {
		allowKeychainPrompt: params.externalCli?.allowKeychainPrompt,
		providerIds: params.externalCli?.externalCliProviderIds,
		profileIds: params.externalCli?.externalCliProfileIds
	}) ?? [];
	for (const profile of cliProfiles) resolved.set(profile.profileId, {
		profileId: profile.profileId,
		credential: profile.credential,
		persistence: profile.persistence ?? "runtime-only"
	});
	for (const rawProfile of profiles) {
		const profile = normalizeExternalAuthProfile(rawProfile);
		if (!profile) continue;
		resolved.set(profile.profileId, profile);
	}
	return resolved;
}
function listRuntimeExternalAuthProfiles(params) {
	return Array.from(resolveExternalAuthProfileMap({
		store: params.store,
		agentDir: params.agentDir,
		env: params.env,
		externalCli: params.externalCli
	}).values());
}
function hasPersistableExternalCliSyncCandidate(store, params) {
	if (params?.externalCliProviderIds || params?.externalCliProfileIds) return true;
	for (const profileId of [CLAUDE_CLI_PROFILE_ID, MINIMAX_CLI_PROFILE_ID]) if (store.profiles[profileId]?.type === "oauth") return true;
	return false;
}
function overlayExternalAuthProfiles(store, params) {
	return overlayRuntimeExternalOAuthProfiles(store, listRuntimeExternalAuthProfiles({
		store,
		agentDir: params?.agentDir,
		env: params?.env,
		externalCli: params
	}));
}
function shouldPersistExternalAuthProfile(params) {
	const profiles = listRuntimeExternalAuthProfiles({
		store: params.store,
		agentDir: params.agentDir,
		env: params.env,
		externalCli: {
			config: params.config,
			externalCliProviderIds: params.externalCliProviderIds,
			externalCliProfileIds: params.externalCliProfileIds
		}
	});
	return shouldPersistRuntimeExternalOAuthProfile({
		profileId: params.profileId,
		credential: params.credential,
		profiles
	});
}
function syncPersistedExternalCliAuthProfiles(store, params) {
	if (!hasPersistableExternalCliSyncCandidate(store, params)) return store;
	const persistedProfiles = (resolveExternalCliAuthProfiles?.(store, {
		allowKeychainPrompt: params?.allowKeychainPrompt,
		providerIds: params?.externalCliProviderIds,
		profileIds: params?.externalCliProfileIds
	}) ?? []).filter((profile) => profile.persistence === "persisted");
	if (persistedProfiles.length === 0) return store;
	let next;
	for (const profile of persistedProfiles) {
		const existing = (next ?? store).profiles[profile.profileId];
		if (existing?.type === "oauth" && areOAuthCredentialsEquivalent(existing, profile.credential)) continue;
		next ??= cloneAuthProfileStore(store);
		next.profiles[profile.profileId] = profile.credential;
	}
	return next ?? store;
}
//#endregion
//#region src/agents/auth-profiles/legacy-oauth-sidecar.ts
const LEGACY_OAUTH_REF_SOURCE = "openclaw-credentials";
const LEGACY_OAUTH_REF_PROVIDER$1 = "openai-codex";
const LEGACY_OAUTH_SECRET_DIRNAME = "auth-profiles";
const LEGACY_OAUTH_SECRET_VERSION = 1;
const LEGACY_OAUTH_SECRET_ALGORITHM = "aes-256-gcm";
const LEGACY_OAUTH_SECRET_KEY_ENV = "OPENCLAW_AUTH_PROFILE_SECRET_KEY";
const LEGACY_OAUTH_SECRET_KEYCHAIN_SERVICE = "OpenClaw Auth Profile Secrets";
const LEGACY_OAUTH_SECRET_KEYCHAIN_ACCOUNT = "oauth-profile-master-key";
const LEGACY_OAUTH_SECRET_KEY_FILE_NAME = "auth-profile-secret-key";
function isRecord$2(value) {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
function readNonEmptyString(value) {
	return typeof value === "string" && value.trim() ? value : void 0;
}
function isLegacyOAuthRef(value) {
	if (!isRecord$2(value)) return false;
	return value.source === LEGACY_OAUTH_REF_SOURCE && value.provider === LEGACY_OAUTH_REF_PROVIDER$1 && typeof value.id === "string" && /^[a-f0-9]{32}$/.test(value.id);
}
function resolveLegacyOAuthSidecarPath(ref, env = process.env) {
	return path.join(resolveOAuthDir(env), LEGACY_OAUTH_SECRET_DIRNAME, `${ref.id}.json`);
}
function normalizeLegacyOAuthSecretMaterial(raw) {
	if (!isRecord$2(raw)) return null;
	const material = {
		...readNonEmptyString(raw.access) ? { access: readNonEmptyString(raw.access) } : {},
		...readNonEmptyString(raw.refresh) ? { refresh: readNonEmptyString(raw.refresh) } : {},
		...readNonEmptyString(raw.idToken) ? { idToken: readNonEmptyString(raw.idToken) } : {}
	};
	return Object.keys(material).length > 0 ? material : null;
}
function coerceLegacyOAuthEncryptedPayload(raw) {
	if (!isRecord$2(raw)) return null;
	return raw.algorithm === LEGACY_OAUTH_SECRET_ALGORITHM && typeof raw.iv === "string" && typeof raw.tag === "string" && typeof raw.ciphertext === "string" ? {
		algorithm: raw.algorithm,
		iv: raw.iv,
		tag: raw.tag,
		ciphertext: raw.ciphertext
	} : null;
}
function isLegacyOAuthSidecarPayload(raw) {
	if (!isRecord$2(raw)) return false;
	if (raw.version !== LEGACY_OAUTH_SECRET_VERSION || readNonEmptyString(raw.profileId) === void 0 || raw.provider !== LEGACY_OAUTH_REF_PROVIDER$1) return false;
	return coerceLegacyOAuthEncryptedPayload(raw.encrypted) !== null || normalizeLegacyOAuthSecretMaterial(raw) !== null;
}
function buildLegacyOAuthSecretAad(params) {
	return Buffer.from(`${params.ref.id}\0${params.profileId}\0${params.provider}`, "utf8");
}
function buildLegacyOAuthSecretKey(seed) {
	return createHash("sha256").update(`openclaw:auth-profile-oauth:${seed}`).digest();
}
function encryptLegacyOAuthMaterialForTest(params) {
	const iv = Buffer.from("0102030405060708090a0b0c", "hex");
	const cipher = createCipheriv(LEGACY_OAUTH_SECRET_ALGORITHM, buildLegacyOAuthSecretKey(params.seed), iv);
	cipher.setAAD(buildLegacyOAuthSecretAad({
		ref: params.ref,
		profileId: params.profileId,
		provider: params.provider
	}));
	const ciphertext = Buffer.concat([cipher.update(JSON.stringify(params.material), "utf8"), cipher.final()]);
	return {
		algorithm: LEGACY_OAUTH_SECRET_ALGORITHM,
		iv: iv.toString("base64url"),
		tag: cipher.getAuthTag().toString("base64url"),
		ciphertext: ciphertext.toString("base64url")
	};
}
function isPathInsideOrEqual(parentDir, candidatePath) {
	const relative = path.relative(path.resolve(parentDir), path.resolve(candidatePath));
	return relative === "" || !!relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}
function uniquePaths(paths) {
	return Array.from(new Set(paths.filter((entry) => Boolean(entry))));
}
function resolveLegacyOAuthSecretKeyFileCandidates(env) {
	if (process.platform === "win32") {
		const home = env.USERPROFILE?.trim() || os.homedir();
		const root = env.APPDATA?.trim() || (home ? path.join(home, "AppData", "Roaming") : void 0);
		return uniquePaths([root ? path.join(root, "OpenClaw", LEGACY_OAUTH_SECRET_KEY_FILE_NAME) : void 0, home ? path.join(home, ".openclaw-auth-profile-secrets", LEGACY_OAUTH_SECRET_KEY_FILE_NAME) : void 0]);
	}
	if (process.platform === "darwin") {
		const home = env.HOME?.trim() || os.homedir();
		return uniquePaths([home ? path.join(home, "Library", "Application Support", "OpenClaw", LEGACY_OAUTH_SECRET_KEY_FILE_NAME) : void 0, home ? path.join(home, ".openclaw-auth-profile-secrets", LEGACY_OAUTH_SECRET_KEY_FILE_NAME) : void 0]);
	}
	const home = env.HOME?.trim() || os.homedir();
	const root = env.XDG_CONFIG_HOME?.trim() || (home ? path.join(home, ".config") : void 0);
	return uniquePaths([root ? path.join(root, "openclaw", LEGACY_OAUTH_SECRET_KEY_FILE_NAME) : void 0, home ? path.join(home, ".openclaw-auth-profile-secrets", LEGACY_OAUTH_SECRET_KEY_FILE_NAME) : void 0]);
}
function resolveLegacyOAuthSecretKeyFilePath(env) {
	const stateDir = resolveStateDir(env);
	return resolveLegacyOAuthSecretKeyFileCandidates(env).find((candidate) => !isPathInsideOrEqual(stateDir, candidate));
}
function readLegacyOAuthSecretKeyFile(env) {
	const keyPath = resolveLegacyOAuthSecretKeyFilePath(env);
	if (!keyPath) return;
	try {
		return fs.readFileSync(keyPath, "utf8").trim() || void 0;
	} catch {
		return;
	}
}
function readLegacyMacOAuthSecretKeychainKey(params) {
	if (process.platform !== "darwin" || params.allowKeychainPrompt === false || params.env.VITEST === "true" || params.env.VITEST_WORKER_ID !== void 0) return;
	try {
		return childProcess.execFileSync("security", [
			"find-generic-password",
			"-s",
			LEGACY_OAUTH_SECRET_KEYCHAIN_SERVICE,
			"-a",
			LEGACY_OAUTH_SECRET_KEYCHAIN_ACCOUNT,
			"-w"
		], {
			encoding: "utf8",
			timeout: 5e3,
			stdio: [
				"pipe",
				"pipe",
				"pipe"
			]
		}).trim();
	} catch {
		return;
	}
}
function resolveLegacyOAuthSecretKeySeeds(env) {
	const seeds = [];
	const addSeed = (value) => {
		const trimmed = value?.trim();
		if (trimmed && !seeds.includes(trimmed)) seeds.push(trimmed);
	};
	addSeed(env[LEGACY_OAUTH_SECRET_KEY_ENV]);
	if (env.NODE_ENV === "test" && env.VITEST === "true") addSeed("openclaw-test-oauth-profile-secret-key");
	addSeed(readLegacyOAuthSecretKeyFile(env));
	return seeds;
}
function decryptLegacyOAuthSecretMaterialWithSeed(params, seed) {
	try {
		const decipher = createDecipheriv(LEGACY_OAUTH_SECRET_ALGORITHM, buildLegacyOAuthSecretKey(seed), Buffer.from(params.encrypted.iv, "base64url"));
		decipher.setAAD(buildLegacyOAuthSecretAad({
			ref: params.ref,
			profileId: params.profileId,
			provider: params.provider
		}));
		decipher.setAuthTag(Buffer.from(params.encrypted.tag, "base64url"));
		const plaintext = Buffer.concat([decipher.update(Buffer.from(params.encrypted.ciphertext, "base64url")), decipher.final()]).toString("utf8");
		return normalizeLegacyOAuthSecretMaterial(JSON.parse(plaintext));
	} catch {
		return null;
	}
}
function decryptLegacyOAuthSecretMaterial(params) {
	const seeds = resolveLegacyOAuthSecretKeySeeds(params.env);
	for (const seed of seeds) {
		const material = decryptLegacyOAuthSecretMaterialWithSeed(params, seed);
		if (material) return material;
	}
	const keychainSeed = readLegacyMacOAuthSecretKeychainKey({
		allowKeychainPrompt: params.allowKeychainPrompt,
		env: params.env
	});
	if (keychainSeed && !seeds.includes(keychainSeed)) return decryptLegacyOAuthSecretMaterialWithSeed(params, keychainSeed);
	return null;
}
function loadLegacyOAuthSidecarMaterial(params) {
	const env = params.env ?? process.env;
	const raw = loadJsonFile(resolveLegacyOAuthSidecarPath(params.ref, env));
	if (!isRecord$2(raw)) return null;
	if (raw.version !== LEGACY_OAUTH_SECRET_VERSION || raw.profileId !== params.profileId || raw.provider !== params.provider) return null;
	const encrypted = coerceLegacyOAuthEncryptedPayload(raw.encrypted);
	if (encrypted) return decryptLegacyOAuthSecretMaterial({
		ref: params.ref,
		profileId: params.profileId,
		provider: params.provider,
		encrypted,
		env,
		allowKeychainPrompt: params.allowKeychainPrompt
	});
	return normalizeLegacyOAuthSecretMaterial(raw);
}
const legacyOAuthSidecarTestUtils = {
	buildLegacyOAuthSecretAad,
	buildLegacyOAuthSecretKey,
	encryptLegacyOAuthMaterial: encryptLegacyOAuthMaterialForTest
};
//#endregion
//#region src/agents/auth-profiles/state.ts
const AUTH_FAILURE_REASONS = new Set([
	"auth",
	"auth_permanent",
	"format",
	"overloaded",
	"rate_limit",
	"billing",
	"timeout",
	"model_not_found",
	"session_expired",
	"empty_response",
	"no_error_details",
	"unclassified",
	"unknown"
]);
const AUTH_BLOCKED_REASONS = new Set(["subscription_limit"]);
const AUTH_BLOCKED_SOURCES = new Set(["codex_rate_limits", "wham"]);
function isRecord$1(value) {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
function normalizeFiniteNumber(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function normalizeEnumValue(value, allowed) {
	if (typeof value !== "string") return;
	return allowed.has(value) ? value : void 0;
}
function normalizeFailureCounts(raw) {
	if (!isRecord$1(raw)) return;
	const normalized = {};
	for (const [reason, count] of Object.entries(raw)) {
		if (!AUTH_FAILURE_REASONS.has(reason)) continue;
		if (typeof count !== "number" || !Number.isFinite(count) || count <= 0) continue;
		normalized[reason] = Math.trunc(count);
	}
	return Object.keys(normalized).length > 0 ? normalized : void 0;
}
function normalizeAuthProfileOrder(raw) {
	if (!isRecord$1(raw)) return;
	const normalized = Object.entries(raw).reduce((acc, [provider, value]) => {
		if (!Array.isArray(value)) return acc;
		const providerKey = normalizeProviderId(provider);
		if (!providerKey) return acc;
		const list = value.map((entry) => normalizeOptionalString(entry) ?? "").filter(Boolean);
		if (list.length > 0) acc[providerKey] = list;
		return acc;
	}, {});
	return Object.keys(normalized).length > 0 ? normalized : void 0;
}
function normalizeLastGood(raw) {
	if (!isRecord$1(raw)) return;
	const normalized = {};
	for (const [provider, profileId] of Object.entries(raw)) {
		const providerKey = normalizeProviderId(provider);
		const normalizedProfileId = normalizeOptionalString(profileId);
		if (!providerKey || !normalizedProfileId) continue;
		normalized[providerKey] = normalizedProfileId;
	}
	return Object.keys(normalized).length > 0 ? normalized : void 0;
}
function normalizeUsageStatsEntry(raw) {
	if (!isRecord$1(raw)) return;
	const stats = {
		lastUsed: normalizeFiniteNumber(raw.lastUsed),
		blockedUntil: normalizeFiniteNumber(raw.blockedUntil),
		blockedReason: normalizeEnumValue(raw.blockedReason, AUTH_BLOCKED_REASONS),
		blockedSource: normalizeEnumValue(raw.blockedSource, AUTH_BLOCKED_SOURCES),
		blockedModel: normalizeOptionalString(raw.blockedModel),
		cooldownUntil: normalizeFiniteNumber(raw.cooldownUntil),
		cooldownReason: normalizeEnumValue(raw.cooldownReason, AUTH_FAILURE_REASONS),
		cooldownModel: normalizeOptionalString(raw.cooldownModel),
		disabledUntil: normalizeFiniteNumber(raw.disabledUntil),
		disabledReason: normalizeEnumValue(raw.disabledReason, AUTH_FAILURE_REASONS),
		errorCount: normalizeFiniteNumber(raw.errorCount),
		failureCounts: normalizeFailureCounts(raw.failureCounts),
		lastFailureAt: normalizeFiniteNumber(raw.lastFailureAt)
	};
	for (const key of Object.keys(stats)) if (stats[key] === void 0) delete stats[key];
	return Object.keys(stats).length > 0 ? stats : void 0;
}
function normalizeUsageStats(raw) {
	if (!isRecord$1(raw)) return;
	const normalized = {};
	for (const [profileId, value] of Object.entries(raw)) {
		const normalizedProfileId = normalizeOptionalString(profileId);
		const stats = normalizeUsageStatsEntry(value);
		if (!normalizedProfileId || !stats) continue;
		normalized[normalizedProfileId] = stats;
	}
	return Object.keys(normalized).length > 0 ? normalized : void 0;
}
function coerceAuthProfileState(raw) {
	if (!isRecord$1(raw)) return {};
	return {
		order: normalizeAuthProfileOrder(raw.order),
		lastGood: normalizeLastGood(raw.lastGood),
		usageStats: normalizeUsageStats(raw.usageStats)
	};
}
function mergeAuthProfileState(base, override) {
	const mergeRecord = (left, right) => {
		if (!left && !right) return;
		if (!left) return { ...right };
		if (!right) return { ...left };
		return {
			...left,
			...right
		};
	};
	return {
		order: mergeRecord(base.order, override.order),
		lastGood: mergeRecord(base.lastGood, override.lastGood),
		usageStats: mergeRecord(base.usageStats, override.usageStats)
	};
}
function loadPersistedAuthProfileState(agentDir) {
	return coerceAuthProfileState(loadJsonFile(resolveAuthStatePath(agentDir)));
}
function buildPersistedAuthProfileState(store) {
	const state = coerceAuthProfileState(store);
	if (!state.order && !state.lastGood && !state.usageStats) return null;
	return {
		version: 1,
		...state.order ? { order: state.order } : {},
		...state.lastGood ? { lastGood: state.lastGood } : {},
		...state.usageStats ? { usageStats: state.usageStats } : {}
	};
}
function savePersistedAuthProfileState(store, agentDir) {
	const payload = buildPersistedAuthProfileState(store);
	const statePath = resolveAuthStatePath(agentDir);
	if (!payload) {
		try {
			fs.unlinkSync(statePath);
		} catch (error) {
			if (error?.code !== "ENOENT") throw error;
		}
		return null;
	}
	saveJsonFile(statePath, payload);
	return payload;
}
//#endregion
//#region src/agents/auth-profiles/persisted.ts
const AUTH_PROFILE_TYPES = new Set([
	"api_key",
	"oauth",
	"token"
]);
const LEGACY_OAUTH_REF_PROVIDER = "openai-codex";
const runtimeLegacyOAuthSidecarCredentials = /* @__PURE__ */ new WeakSet();
const runtimeLegacyOAuthSidecarMaterialFingerprints = /* @__PURE__ */ new Map();
function isRecord(value) {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
function normalizeOptionalCredentialString(value) {
	if (typeof value !== "string") return;
	return value.trim() ? value : void 0;
}
function hasInlineOAuthTokenMaterial(credential) {
	return [
		credential.access,
		credential.refresh,
		credential.idToken
	].some((value) => typeof value === "string" && value.trim().length > 0);
}
function buildRuntimeLegacyOAuthSidecarFingerprintKey(params) {
	return `${params.storeKey ?? ""}\0${params.profileId}`;
}
function buildLegacyOAuthSecretMaterialFingerprint(material) {
	return createHash("sha256").update(JSON.stringify([
		material.access ?? null,
		material.refresh ?? null,
		material.idToken ?? null
	])).digest("hex");
}
function normalizeOptionalCredentialBoolean(value) {
	return typeof value === "boolean" ? value : void 0;
}
function normalizeExpiryField(value) {
	if (value === void 0) return;
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}
function normalizeCredentialMetadata(value) {
	if (!isRecord(value)) return;
	const metadata = {};
	for (const [key, entry] of Object.entries(value)) if (typeof entry === "string") metadata[key] = entry;
	return Object.keys(metadata).length > 0 ? metadata : void 0;
}
function normalizeSecretBackedField(params) {
	const value = params.entry[params.valueField];
	if (value == null || typeof value === "string") return;
	const ref = coerceSecretRef(value);
	if (ref && !coerceSecretRef(params.entry[params.refField])) params.entry[params.refField] = ref;
	delete params.entry[params.valueField];
}
function normalizeCommonCredentialFields(entry) {
	const normalized = { provider: typeof entry.provider === "string" ? normalizeProviderId(entry.provider) : "" };
	const copyToAgents = normalizeOptionalCredentialBoolean(entry.copyToAgents);
	if (copyToAgents !== void 0) normalized.copyToAgents = copyToAgents;
	const email = normalizeOptionalCredentialString(entry.email);
	if (email !== void 0) normalized.email = email;
	const displayName = normalizeOptionalCredentialString(entry.displayName);
	if (displayName !== void 0) normalized.displayName = displayName;
	return normalized;
}
function normalizeRawCredentialEntry(raw) {
	const entry = { ...raw };
	if (!("type" in entry) && typeof entry["mode"] === "string") entry["type"] = entry["mode"];
	if (!("key" in entry) && typeof entry["apiKey"] === "string") entry["key"] = entry["apiKey"];
	normalizeSecretBackedField({
		entry,
		valueField: "key",
		refField: "keyRef"
	});
	normalizeSecretBackedField({
		entry,
		valueField: "token",
		refField: "tokenRef"
	});
	if (entry.type === "api_key") {
		const normalized = {
			type: "api_key",
			...normalizeCommonCredentialFields(entry)
		};
		const key = normalizeOptionalCredentialString(entry.key);
		const keyRef = coerceSecretRef(entry.keyRef);
		const metadata = normalizeCredentialMetadata(entry.metadata);
		if (key !== void 0) normalized.key = key;
		if (keyRef) normalized.keyRef = keyRef;
		if (metadata) normalized.metadata = metadata;
		return normalized;
	}
	if (entry.type === "token") {
		const normalized = {
			type: "token",
			...normalizeCommonCredentialFields(entry)
		};
		const token = normalizeOptionalCredentialString(entry.token);
		const tokenRef = coerceSecretRef(entry.tokenRef);
		const expires = normalizeExpiryField(entry.expires);
		if (token !== void 0) normalized.token = token;
		if (tokenRef) normalized.tokenRef = tokenRef;
		if (expires !== void 0) normalized.expires = expires;
		return normalized;
	}
	if (entry.type === "oauth") {
		const normalized = {
			type: "oauth",
			...normalizeCommonCredentialFields(entry)
		};
		for (const field of [
			"access",
			"refresh",
			"idToken",
			"clientId",
			"enterpriseUrl",
			"projectId",
			"accountId",
			"chatgptPlanType"
		]) {
			const value = normalizeOptionalCredentialString(entry[field]);
			if (value !== void 0) normalized[field] = value;
		}
		const expires = normalizeExpiryField(entry.expires);
		if (expires !== void 0) normalized.expires = expires;
		return normalized;
	}
	return entry;
}
function parseCredentialEntry(raw, fallbackProvider) {
	if (!isRecord(raw)) return {
		ok: false,
		reason: "non_object"
	};
	const typed = normalizeRawCredentialEntry(raw);
	if (!AUTH_PROFILE_TYPES.has(typed.type)) return {
		ok: false,
		reason: "invalid_type"
	};
	const provider = typed.provider ?? fallbackProvider;
	const normalizedProvider = typeof provider === "string" ? normalizeProviderId(provider) : "";
	if (!normalizedProvider) return {
		ok: false,
		reason: "missing_provider"
	};
	return {
		ok: true,
		credential: {
			...typed,
			provider: normalizedProvider
		}
	};
}
function warnRejectedCredentialEntries(source, rejected) {
	if (rejected.length === 0) return;
	const reasons = rejected.reduce((acc, current) => {
		acc[current.reason] = (acc[current.reason] ?? 0) + 1;
		return acc;
	}, {});
	log$1.warn("ignored invalid auth profile entries during store load", {
		source,
		dropped: rejected.length,
		reasons,
		keys: rejected.slice(0, 10).map((entry) => entry.key)
	});
}
function resolveLegacyOAuthSidecarCredential(params) {
	if (params.credential.type !== "oauth" || normalizeProviderId(params.credential.provider) !== LEGACY_OAUTH_REF_PROVIDER || hasInlineOAuthTokenMaterial(params.credential) || !isRecord(params.raw) || !isLegacyOAuthRef(params.raw.oauthRef)) return params.credential;
	const material = loadLegacyOAuthSidecarMaterial({
		ref: params.raw.oauthRef,
		profileId: params.profileId,
		provider: params.credential.provider,
		allowKeychainPrompt: params.options?.allowKeychainPrompt
	});
	if (!material) return params.credential;
	const credential = {
		...params.credential,
		...material.access ? { access: material.access } : {},
		...material.refresh ? { refresh: material.refresh } : {},
		...material.idToken ? { idToken: material.idToken } : {}
	};
	runtimeLegacyOAuthSidecarCredentials.add(credential);
	runtimeLegacyOAuthSidecarMaterialFingerprints.set(buildRuntimeLegacyOAuthSidecarFingerprintKey({
		storeKey: params.storeKey,
		profileId: params.profileId
	}), buildLegacyOAuthSecretMaterialFingerprint(credential));
	return credential;
}
function isRuntimeLegacyOAuthSidecarCredential(credential) {
	return credential?.type === "oauth" && runtimeLegacyOAuthSidecarCredentials.has(credential);
}
function matchesRuntimeLegacyOAuthSidecarMaterial(params) {
	if (params.credential?.type !== "oauth") return false;
	if (runtimeLegacyOAuthSidecarCredentials.has(params.credential)) return true;
	const fingerprint = runtimeLegacyOAuthSidecarMaterialFingerprints.get(buildRuntimeLegacyOAuthSidecarFingerprintKey({
		storeKey: params.authPath,
		profileId: params.profileId
	}));
	return fingerprint !== void 0 && fingerprint === buildLegacyOAuthSecretMaterialFingerprint(params.credential);
}
function coerceLegacyAuthStore(raw) {
	if (!isRecord(raw)) return null;
	const record = raw;
	if ("profiles" in record) return null;
	const entries = {};
	const rejected = [];
	for (const [key, value] of Object.entries(record)) {
		const parsed = parseCredentialEntry(value, key);
		if (!parsed.ok) {
			rejected.push({
				key,
				reason: parsed.reason
			});
			continue;
		}
		entries[key] = parsed.credential;
	}
	warnRejectedCredentialEntries("auth.json", rejected);
	return Object.keys(entries).length > 0 ? entries : null;
}
function coercePersistedAuthProfileStore(raw, options, storeKey) {
	if (!isRecord(raw)) return null;
	const record = raw;
	if (!isRecord(record.profiles)) return null;
	const profiles = record.profiles;
	const normalized = {};
	const rejected = [];
	for (const [key, value] of Object.entries(profiles)) {
		const parsed = parseCredentialEntry(value);
		if (!parsed.ok) {
			rejected.push({
				key,
				reason: parsed.reason
			});
			continue;
		}
		normalized[key] = options?.resolveLegacyOAuthSidecars === true ? resolveLegacyOAuthSidecarCredential({
			profileId: key,
			raw: value,
			credential: parsed.credential,
			storeKey,
			options
		}) : parsed.credential;
	}
	warnRejectedCredentialEntries("auth-profiles.json", rejected);
	const version = Number(record.version ?? 1);
	return {
		version: Number.isFinite(version) && version > 0 ? version : 1,
		profiles: normalized,
		...coerceAuthProfileState(record)
	};
}
function mergeRecord(base, override) {
	if (!base && !override) return;
	if (!base) return { ...override };
	if (!override) return { ...base };
	return {
		...base,
		...override
	};
}
function dedupeMergedProfileOrder(profileIds) {
	return Array.from(new Set(profileIds));
}
function hasComparableOAuthIdentityConflict(existing, candidate) {
	const existingAccountId = normalizeAuthIdentityToken$1(existing.accountId);
	const candidateAccountId = normalizeAuthIdentityToken$1(candidate.accountId);
	if (existingAccountId !== void 0 && candidateAccountId !== void 0 && existingAccountId !== candidateAccountId) return true;
	const existingEmail = normalizeAuthEmailToken$1(existing.email);
	const candidateEmail = normalizeAuthEmailToken$1(candidate.email);
	return existingEmail !== void 0 && candidateEmail !== void 0 && existingEmail !== candidateEmail;
}
function isLegacyDefaultOAuthProfile(profileId, credential) {
	return profileId === `${normalizeProviderId(credential.provider)}:default`;
}
function isNewerUsableOAuthCredential(existing, candidate) {
	if (!hasUsableOAuthCredential(candidate)) return false;
	if (!hasUsableOAuthCredential(existing)) return true;
	return Number.isFinite(candidate.expires) && (!Number.isFinite(existing.expires) || candidate.expires > existing.expires);
}
const AUTH_INVALIDATION_REASONS = new Set([
	"auth",
	"auth_permanent",
	"session_expired"
]);
function hasAuthInvalidationSignal(stats) {
	if (!stats) return false;
	if (stats.cooldownReason && AUTH_INVALIDATION_REASONS.has(stats.cooldownReason) || stats.disabledReason && AUTH_INVALIDATION_REASONS.has(stats.disabledReason)) return true;
	return Object.entries(stats.failureCounts ?? {}).some(([reason, count]) => AUTH_INVALIDATION_REASONS.has(reason) && typeof count === "number" && count > 0);
}
function isProfileReferencedByAuthState(store, profileId) {
	if (Object.values(store.order ?? {}).some((profileIds) => profileIds.includes(profileId))) return true;
	return Object.values(store.lastGood ?? {}).some((value) => value === profileId);
}
function resolveProviderAuthStateValue(values, providerKey) {
	if (!values) return;
	for (const [key, value] of Object.entries(values)) if (normalizeProviderId(key) === providerKey) return value;
}
function findMainStoreOAuthReplacementForInvalidatedProfile(params) {
	const providerKey = normalizeProviderId(params.credential.provider);
	if (providerKey !== "openai-codex" || !isProfileReferencedByAuthState(params.override, params.profileId) || !hasAuthInvalidationSignal(params.override.usageStats?.[params.profileId])) return;
	const candidates = Object.entries(params.base.profiles).flatMap(([profileId, credential]) => {
		if (profileId === params.profileId || credential.type !== "oauth" || normalizeProviderId(credential.provider) !== providerKey || !hasUsableOAuthCredential(credential)) return [];
		return [[profileId, credential]];
	}).toSorted(([leftId, leftCredential], [rightId, rightCredential]) => {
		const leftExpires = Number.isFinite(leftCredential.expires) ? leftCredential.expires : 0;
		const rightExpires = Number.isFinite(rightCredential.expires) ? rightCredential.expires : 0;
		if (rightExpires !== leftExpires) return rightExpires - leftExpires;
		return leftId.localeCompare(rightId);
	});
	if (candidates.length === 0) return;
	const candidateIds = new Set(candidates.map(([profileId]) => profileId));
	const orderedProfileId = resolveProviderAuthStateValue(params.base.order, providerKey)?.find((profileId) => candidateIds.has(profileId));
	if (orderedProfileId) return orderedProfileId;
	const lastGoodProfileId = resolveProviderAuthStateValue(params.base.lastGood, providerKey);
	if (lastGoodProfileId && candidateIds.has(lastGoodProfileId)) return lastGoodProfileId;
	return candidates.length === 1 ? candidates[0]?.[0] : void 0;
}
function findMainStoreOAuthReplacement(params) {
	const providerKey = normalizeProviderId(params.legacyCredential.provider);
	const candidates = Object.entries(params.base.profiles).flatMap(([profileId, credential]) => {
		if (profileId === params.legacyProfileId || credential.type !== "oauth" || normalizeProviderId(credential.provider) !== providerKey) return [];
		return [[profileId, credential]];
	}).filter(([, credential]) => isNewerUsableOAuthCredential(params.legacyCredential, credential)).toSorted(([leftId, leftCredential], [rightId, rightCredential]) => {
		const leftExpires = Number.isFinite(leftCredential.expires) ? leftCredential.expires : 0;
		const rightExpires = Number.isFinite(rightCredential.expires) ? rightCredential.expires : 0;
		if (rightExpires !== leftExpires) return rightExpires - leftExpires;
		return leftId.localeCompare(rightId);
	});
	const exactIdentityCandidates = candidates.filter(([, credential]) => isSafeToAdoptMainStoreOAuthIdentity(params.legacyCredential, credential));
	if (exactIdentityCandidates.length > 0) {
		if (!hasOAuthIdentity(params.legacyCredential) && exactIdentityCandidates.length > 1) return;
		return exactIdentityCandidates[0]?.[0];
	}
	if (hasUsableOAuthCredential(params.legacyCredential)) return;
	const fallbackCandidates = candidates.filter(([, credential]) => !hasComparableOAuthIdentityConflict(params.legacyCredential, credential));
	if (fallbackCandidates.length !== 1) return;
	return fallbackCandidates[0]?.[0];
}
function replaceMergedProfileReferences(params) {
	const { store, base, replacements } = params;
	if (replacements.size === 0) return store;
	const profiles = { ...store.profiles };
	for (const [legacyProfileId, replacementProfileId] of replacements) {
		const baseCredential = base.profiles[legacyProfileId];
		if (baseCredential) profiles[legacyProfileId] = baseCredential;
		else delete profiles[legacyProfileId];
		const replacementBaseCredential = base.profiles[replacementProfileId];
		const replacementCredential = profiles[replacementProfileId];
		if (replacementBaseCredential && (!replacementCredential || replacementCredential.type === "oauth" && replacementBaseCredential.type === "oauth" && isNewerUsableOAuthCredential(replacementCredential, replacementBaseCredential))) profiles[replacementProfileId] = replacementBaseCredential;
	}
	const order = store.order ? Object.fromEntries(Object.entries(store.order).map(([provider, profileIds]) => [provider, dedupeMergedProfileOrder(profileIds.map((profileId) => replacements.get(profileId) ?? profileId))])) : void 0;
	const lastGood = store.lastGood ? Object.fromEntries(Object.entries(store.lastGood).map(([provider, profileId]) => [provider, replacements.get(profileId) ?? profileId])) : void 0;
	const usageStats = store.usageStats ? { ...store.usageStats } : void 0;
	if (usageStats) for (const legacyProfileId of replacements.keys()) {
		const baseStats = base.usageStats?.[legacyProfileId];
		if (baseStats) usageStats[legacyProfileId] = baseStats;
		else delete usageStats[legacyProfileId];
	}
	return {
		...store,
		profiles,
		...order && Object.keys(order).length > 0 ? { order } : { order: void 0 },
		...lastGood && Object.keys(lastGood).length > 0 ? { lastGood } : { lastGood: void 0 },
		...usageStats && Object.keys(usageStats).length > 0 ? { usageStats } : { usageStats: void 0 }
	};
}
function reconcileMainStoreOAuthProfileDrift(params) {
	const replacements = /* @__PURE__ */ new Map();
	for (const [profileId, credential] of Object.entries(params.override.profiles)) {
		if (credential.type !== "oauth") continue;
		const replacementProfileId = isLegacyDefaultOAuthProfile(profileId, credential) ? findMainStoreOAuthReplacement({
			base: params.base,
			legacyProfileId: profileId,
			legacyCredential: credential
		}) : findMainStoreOAuthReplacementForInvalidatedProfile({
			base: params.base,
			override: params.override,
			profileId,
			credential
		});
		if (replacementProfileId) replacements.set(profileId, replacementProfileId);
	}
	return replaceMergedProfileReferences({
		store: params.merged,
		base: params.base,
		replacements
	});
}
function mergeAuthProfileStores(base, override) {
	if (Object.keys(override.profiles).length === 0 && !override.order && !override.lastGood && !override.usageStats) return base;
	return reconcileMainStoreOAuthProfileDrift({
		base,
		override,
		merged: {
			version: Math.max(base.version, override.version ?? base.version),
			profiles: {
				...base.profiles,
				...override.profiles
			},
			order: mergeRecord(base.order, override.order),
			lastGood: mergeRecord(base.lastGood, override.lastGood),
			usageStats: mergeRecord(base.usageStats, override.usageStats)
		}
	});
}
function buildPersistedAuthProfileSecretsStore(store, shouldPersistProfile, options) {
	return preserveLegacyOAuthRefsForDoctorMigration({
		version: 1,
		profiles: Object.fromEntries(Object.entries(store.profiles).flatMap(([profileId, credential]) => {
			if (shouldPersistProfile && !shouldPersistProfile({
				profileId,
				credential
			})) return [];
			if (credential.type === "api_key" && credential.keyRef && credential.key !== void 0) {
				const sanitized = { ...credential };
				delete sanitized.key;
				return [[profileId, sanitized]];
			}
			if (credential.type === "token" && credential.tokenRef && credential.token !== void 0) {
				const sanitized = { ...credential };
				delete sanitized.token;
				return [[profileId, sanitized]];
			}
			return [[profileId, credential]];
		}))
	}, options);
}
function preserveLegacyOAuthRefsForDoctorMigration(payload, options) {
	const existingRaw = options?.existingRaw;
	if (!isRecord(existingRaw) || !isRecord(existingRaw.profiles)) return payload;
	let profiles;
	for (const [profileId, rawProfile] of Object.entries(existingRaw.profiles)) {
		if (!isRecord(rawProfile) || !isLegacyOAuthRef(rawProfile.oauthRef)) continue;
		const credential = payload.profiles[profileId];
		if (credential?.type !== "oauth" || normalizeProviderId(credential.provider) !== LEGACY_OAUTH_REF_PROVIDER) continue;
		if (hasInlineOAuthTokenMaterial(credential)) {
			if (!(options?.runtimeLegacyOAuthSidecarProfileIds?.has(profileId) === true) && !isUnchangedLegacyOAuthSidecarMaterial({
				profileId,
				rawProfile,
				credential
			})) continue;
		}
		profiles ??= { ...payload.profiles };
		const sanitized = { ...credential };
		delete sanitized.access;
		delete sanitized.refresh;
		delete sanitized.idToken;
		profiles[profileId] = {
			...sanitized,
			oauthRef: rawProfile.oauthRef
		};
	}
	return profiles ? {
		...payload,
		profiles
	} : payload;
}
function isUnchangedLegacyOAuthSidecarMaterial(params) {
	if (!isLegacyOAuthRef(params.rawProfile.oauthRef)) return false;
	const material = loadLegacyOAuthSidecarMaterial({
		ref: params.rawProfile.oauthRef,
		profileId: params.profileId,
		provider: params.credential.provider,
		allowKeychainPrompt: false
	});
	if (!material) return false;
	return isSameLegacyOAuthSecretMaterial(params.credential, material);
}
function isSameLegacyOAuthSecretMaterial(credential, material) {
	return [
		"access",
		"refresh",
		"idToken"
	].every((field) => (credential[field] ?? void 0) === (material[field] ?? void 0));
}
function applyLegacyAuthStore(store, legacy) {
	for (const [provider, cred] of Object.entries(legacy)) {
		const profileId = `${provider}:default`;
		const credentialProvider = cred.provider ?? provider;
		if (cred.type === "api_key") {
			store.profiles[profileId] = {
				type: "api_key",
				provider: credentialProvider,
				key: cred.key,
				...cred.email ? { email: cred.email } : {}
			};
			continue;
		}
		if (cred.type === "token") {
			store.profiles[profileId] = {
				type: "token",
				provider: credentialProvider,
				token: cred.token,
				...typeof cred.expires === "number" ? { expires: cred.expires } : {},
				...cred.email ? { email: cred.email } : {}
			};
			continue;
		}
		store.profiles[profileId] = {
			type: "oauth",
			provider: credentialProvider,
			access: cred.access,
			refresh: cred.refresh,
			expires: cred.expires,
			...cred.enterpriseUrl ? { enterpriseUrl: cred.enterpriseUrl } : {},
			...cred.projectId ? { projectId: cred.projectId } : {},
			...cred.accountId ? { accountId: cred.accountId } : {},
			...cred.email ? { email: cred.email } : {}
		};
	}
}
function mergeOAuthFileIntoStore(store) {
	const oauthRaw = loadJsonFile(resolveOAuthPath());
	if (!oauthRaw || typeof oauthRaw !== "object") return false;
	const oauthEntries = oauthRaw;
	let mutated = false;
	for (const [provider, creds] of Object.entries(oauthEntries)) {
		if (!creds || typeof creds !== "object") continue;
		const profileId = `${provider}:default`;
		if (store.profiles[profileId]) continue;
		store.profiles[profileId] = {
			type: "oauth",
			provider,
			...creds
		};
		mutated = true;
	}
	return mutated;
}
function loadPersistedAuthProfileStore(agentDir, options) {
	const authPath = resolveAuthStorePath(agentDir);
	const raw = loadJsonFile(authPath);
	const store = coercePersistedAuthProfileStore(raw, options, authPath);
	if (!store) return null;
	return {
		...store,
		...mergeAuthProfileState(coerceAuthProfileState(raw), loadPersistedAuthProfileState(agentDir))
	};
}
function loadLegacyAuthProfileStore(agentDir) {
	return coerceLegacyAuthStore(loadJsonFile(resolveLegacyAuthStorePath(agentDir)));
}
//#endregion
//#region src/agents/auth-profiles/store.ts
function resolvePersistedLoadOptions(options) {
	return {
		resolveLegacyOAuthSidecars: options?.resolveLegacyOAuthSidecars ?? true,
		...options?.allowKeychainPrompt !== void 0 ? { allowKeychainPrompt: options.allowKeychainPrompt } : {}
	};
}
function isInheritedMainOAuthCredential(params) {
	if (!params.agentDir || params.credential.type !== "oauth") return false;
	if (resolveAuthStorePath(params.agentDir) === resolveAuthStorePath()) return false;
	if (loadPersistedAuthProfileStore(params.agentDir)?.profiles[params.profileId]) return false;
	const mainCredential = loadPersistedAuthProfileStore()?.profiles[params.profileId];
	return mainCredential?.type === "oauth" && (isDeepStrictEqual(mainCredential, params.credential) || shouldUseMainOwnerForLocalOAuthCredential({
		local: params.credential,
		main: mainCredential
	}));
}
function shouldUseMainOwnerForLocalOAuthCredential(params) {
	if (params.local.type !== "oauth" || params.main?.type !== "oauth") return false;
	if (!isSafeToAdoptMainStoreOAuthIdentity(params.local, params.main)) return false;
	if (isDeepStrictEqual(params.local, params.main)) return true;
	return Number.isFinite(params.main.expires) && (!Number.isFinite(params.local.expires) || params.main.expires >= params.local.expires);
}
function resolveRuntimeAuthProfileStore(agentDir, options) {
	const mainKey = resolveAuthStorePath(void 0);
	const requestedKey = resolveAuthStorePath(agentDir);
	const mainStore = getRuntimeAuthProfileStoreSnapshot(void 0);
	const requestedStore = getRuntimeAuthProfileStoreSnapshot(agentDir);
	if (!agentDir || requestedKey === mainKey) {
		if (!mainStore) return null;
		return mainStore;
	}
	if (mainStore && requestedStore) return mergeAuthProfileStores(mainStore, requestedStore);
	if (requestedStore) return mergeAuthProfileStores(loadAuthProfileStoreForAgent(void 0, {
		readOnly: true,
		syncExternalCli: false,
		...resolvePersistedLoadOptions(options)
	}), requestedStore);
	if (mainStore) return mainStore;
	return null;
}
function readAuthStoreMtimeMs(authPath) {
	try {
		return fs.statSync(authPath).mtimeMs;
	} catch {
		return null;
	}
}
function readSyncLockSnapshot(lockPath) {
	try {
		const stat = fs.lstatSync(lockPath);
		const raw = fs.readFileSync(lockPath, "utf8");
		let payload = null;
		try {
			const parsed = JSON.parse(raw);
			payload = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
		} catch {
			payload = null;
		}
		return {
			raw,
			stat,
			payload
		};
	} catch {
		return null;
	}
}
function syncLockSnapshotMatches(lockPath, snapshot) {
	try {
		const stat = fs.lstatSync(lockPath);
		return stat.dev === snapshot.stat.dev && stat.ino === snapshot.stat.ino && fs.readFileSync(lockPath, "utf8") === snapshot.raw;
	} catch {
		return false;
	}
}
function acquireAuthStoreLockSync(authPath) {
	const lockPath = `${authPath}.lock`;
	fs.mkdirSync(path.dirname(authPath), { recursive: true });
	try {
		const fd = fs.openSync(lockPath, "wx");
		const raw = `${JSON.stringify({
			pid: process.pid,
			createdAt: (/* @__PURE__ */ new Date()).toISOString()
		}, null, 2)}\n`;
		try {
			fs.writeFileSync(fd, raw, "utf8");
		} finally {
			fs.closeSync(fd);
		}
		const snapshot = readSyncLockSnapshot(lockPath);
		return () => {
			if (snapshot && syncLockSnapshotMatches(lockPath, snapshot)) fs.rmSync(lockPath, { force: true });
		};
	} catch (err) {
		if (err?.code === "EEXIST") return null;
		throw err;
	}
}
function resolveExternalCliOverlayOptions(options) {
	const discovery = options?.externalCli;
	if (!discovery) return {
		...options?.allowKeychainPrompt !== void 0 ? { allowKeychainPrompt: options.allowKeychainPrompt } : {},
		...options?.config ? { config: options.config } : {},
		...options?.externalCliProviderIds ? { externalCliProviderIds: options.externalCliProviderIds } : {},
		...options?.externalCliProfileIds ? { externalCliProfileIds: options.externalCliProfileIds } : {}
	};
	if (discovery.mode === "none") {
		const config = discovery.config ?? options?.config;
		return {
			allowKeychainPrompt: false,
			...config ? { config } : {},
			externalCliProviderIds: [],
			externalCliProfileIds: []
		};
	}
	if (discovery.mode === "existing") {
		const allowKeychainPrompt = discovery.allowKeychainPrompt ?? options?.allowKeychainPrompt;
		const config = discovery.config ?? options?.config;
		return {
			...allowKeychainPrompt !== void 0 ? { allowKeychainPrompt } : {},
			...config ? { config } : {}
		};
	}
	const allowKeychainPrompt = discovery.allowKeychainPrompt ?? options?.allowKeychainPrompt;
	const config = discovery.config ?? options?.config;
	return {
		...allowKeychainPrompt !== void 0 ? { allowKeychainPrompt } : {},
		...config ? { config } : {},
		...discovery.providerIds ? { externalCliProviderIds: discovery.providerIds } : {},
		...discovery.profileIds ? { externalCliProfileIds: discovery.profileIds } : {}
	};
}
function maybeSyncPersistedExternalCliAuthProfiles(params) {
	if (params.options?.readOnly === true || params.options?.syncExternalCli === false || process.env.OPENCLAW_AUTH_STORE_READONLY === "1") return {
		store: params.store,
		cacheable: true
	};
	const synced = syncPersistedExternalCliAuthProfiles(params.store, {
		agentDir: params.agentDir,
		...resolveExternalCliOverlayOptions(params.options)
	});
	if (synced === params.store) return {
		store: params.store,
		cacheable: true
	};
	const changedProfiles = Object.entries(synced.profiles).filter(([profileId, credential]) => {
		const previous = params.store.profiles[profileId];
		return !isDeepStrictEqual(previous, credential);
	});
	if (changedProfiles.length === 0) return {
		store: synced,
		cacheable: true
	};
	const authPath = resolveAuthStorePath(params.agentDir);
	const release = acquireAuthStoreLockSync(authPath);
	if (!release) {
		log$1.warn("skipped persisted external cli auth sync because auth store is locked", { authPath });
		return {
			store: params.store,
			cacheable: false
		};
	}
	try {
		const latestStore = loadPersistedAuthProfileStore(params.agentDir, resolvePersistedLoadOptions(params.options)) ?? {
			version: 1,
			profiles: {}
		};
		let changed = false;
		for (const [profileId, credential] of changedProfiles) {
			const previous = params.store.profiles[profileId];
			const latest = latestStore.profiles[profileId];
			if (!isDeepStrictEqual(latest, previous)) {
				log$1.debug("skipped persisted external cli auth sync for concurrently changed profile", { profileId });
				continue;
			}
			latestStore.profiles[profileId] = credential;
			changed = true;
		}
		if (changed) {
			saveAuthProfileStore(latestStore, params.agentDir, { filterExternalAuthProfiles: false });
			return {
				store: latestStore,
				cacheable: true
			};
		}
		return {
			store: latestStore,
			cacheable: true
		};
	} finally {
		release();
	}
}
function shouldKeepProfileInLocalStore(params) {
	if (params.credential.type !== "oauth") return true;
	if (isInheritedMainOAuthCredential({
		agentDir: params.agentDir,
		profileId: params.profileId,
		credential: params.credential
	})) return false;
	if (params.options?.filterExternalAuthProfiles === false) return true;
	return shouldPersistExternalAuthProfile({
		store: params.store,
		profileId: params.profileId,
		credential: params.credential,
		agentDir: params.agentDir
	});
}
function buildLocalAuthProfileStoreForSave(params) {
	const localStore = cloneAuthProfileStore(params.store);
	localStore.profiles = Object.fromEntries(Object.entries(localStore.profiles).filter(([profileId, credential]) => shouldKeepProfileInLocalStore({
		store: params.store,
		profileId,
		credential,
		agentDir: params.agentDir,
		options: params.options
	})));
	const keptProfileIds = new Set(Object.keys(localStore.profiles));
	localStore.order = localStore.order ? Object.fromEntries(Object.entries(localStore.order).map(([provider, profileIds]) => [provider, profileIds.filter((profileId) => keptProfileIds.has(profileId))]).filter(([, profileIds]) => profileIds.length > 0)) : void 0;
	localStore.lastGood = localStore.lastGood ? Object.fromEntries(Object.entries(localStore.lastGood).filter(([, profileId]) => keptProfileIds.has(profileId))) : void 0;
	localStore.usageStats = localStore.usageStats ? Object.fromEntries(Object.entries(localStore.usageStats).filter(([profileId]) => keptProfileIds.has(profileId))) : void 0;
	return localStore;
}
async function updateAuthProfileStoreWithLock(params) {
	const authPath = resolveAuthStorePath(params.agentDir);
	ensureAuthStoreFile(authPath);
	try {
		return await withFileLock(authPath, AUTH_STORE_LOCK_OPTIONS, async () => {
			const store = loadAuthProfileStoreForAgent(params.agentDir, { syncExternalCli: false });
			if (params.updater(store)) saveAuthProfileStore(store, params.agentDir, params.saveOptions);
			return store;
		});
	} catch {
		return null;
	}
}
function loadAuthProfileStore() {
	const asStore = loadPersistedAuthProfileStore();
	if (asStore) return overlayExternalAuthProfiles(asStore);
	const legacy = loadLegacyAuthProfileStore();
	if (legacy) {
		const store = {
			version: 1,
			profiles: {}
		};
		applyLegacyAuthStore(store, legacy);
		return overlayExternalAuthProfiles(store);
	}
	return overlayExternalAuthProfiles({
		version: 1,
		profiles: {}
	});
}
function loadAuthProfileStoreForAgent(agentDir, options) {
	const readOnly = options?.readOnly === true;
	const authPath = resolveAuthStorePath(agentDir);
	const statePath = resolveAuthStatePath(agentDir);
	const authMtimeMs = readAuthStoreMtimeMs(authPath);
	const stateMtimeMs = readAuthStoreMtimeMs(statePath);
	if (!readOnly) {
		const cached = readCachedAuthProfileStore({
			authPath,
			authMtimeMs,
			stateMtimeMs
		});
		if (cached) return cached;
	}
	const asStore = loadPersistedAuthProfileStore(agentDir, resolvePersistedLoadOptions(options));
	if (asStore) {
		const synced = maybeSyncPersistedExternalCliAuthProfiles({
			store: asStore,
			agentDir,
			options
		});
		if (!readOnly && synced.cacheable) writeCachedAuthProfileStore({
			authPath,
			authMtimeMs: readAuthStoreMtimeMs(authPath),
			stateMtimeMs: readAuthStoreMtimeMs(statePath),
			store: synced.store
		});
		return synced.store;
	}
	const legacy = loadLegacyAuthProfileStore(agentDir);
	const store = {
		version: 1,
		profiles: {}
	};
	if (legacy) applyLegacyAuthStore(store, legacy);
	const mergedOAuth = mergeOAuthFileIntoStore(store);
	const forceReadOnly = process.env.OPENCLAW_AUTH_STORE_READONLY === "1";
	const shouldWrite = !readOnly && !forceReadOnly && (legacy !== null || mergedOAuth);
	if (shouldWrite) saveAuthProfileStore(store, agentDir);
	if (shouldWrite && legacy !== null) {
		const legacyPath = resolveLegacyAuthStorePath(agentDir);
		try {
			fs.unlinkSync(legacyPath);
		} catch (err) {
			if (err?.code !== "ENOENT") log$1.warn("failed to delete legacy auth.json after migration", {
				err,
				legacyPath
			});
		}
	}
	const synced = maybeSyncPersistedExternalCliAuthProfiles({
		store,
		agentDir,
		options
	});
	if (!readOnly && synced.cacheable) writeCachedAuthProfileStore({
		authPath,
		authMtimeMs: readAuthStoreMtimeMs(authPath),
		stateMtimeMs: readAuthStoreMtimeMs(statePath),
		store: synced.store
	});
	return synced.store;
}
function loadAuthProfileStoreForRuntime(agentDir, options) {
	const store = loadAuthProfileStoreForAgent(agentDir, options);
	const authPath = resolveAuthStorePath(agentDir);
	const mainAuthPath = resolveAuthStorePath();
	const externalCli = resolveExternalCliOverlayOptions(options);
	if (!agentDir || authPath === mainAuthPath) return overlayExternalAuthProfiles(store, {
		agentDir,
		...externalCli
	});
	return overlayExternalAuthProfiles(mergeAuthProfileStores(loadAuthProfileStoreForAgent(void 0, options), store), {
		agentDir,
		...externalCli
	});
}
function loadAuthProfileStoreForSecretsRuntime(agentDir) {
	return loadAuthProfileStoreForRuntime(agentDir, {
		readOnly: true,
		allowKeychainPrompt: false,
		resolveLegacyOAuthSidecars: true
	});
}
function loadAuthProfileStoreWithoutExternalProfiles(agentDir, loadOptions) {
	const options = {
		readOnly: true,
		allowKeychainPrompt: loadOptions?.allowKeychainPrompt ?? false,
		resolveLegacyOAuthSidecars: loadOptions?.resolveLegacyOAuthSidecars ?? true
	};
	const store = loadAuthProfileStoreForAgent(agentDir, options);
	const authPath = resolveAuthStorePath(agentDir);
	const mainAuthPath = resolveAuthStorePath();
	if (!agentDir || authPath === mainAuthPath) return store;
	return mergeAuthProfileStores(loadAuthProfileStoreForAgent(void 0, options), store);
}
function ensureAuthProfileStore(agentDir, options) {
	const externalCli = resolveExternalCliOverlayOptions(options);
	return overlayExternalAuthProfiles(ensureAuthProfileStoreWithoutExternalProfiles(agentDir, options), {
		agentDir,
		...externalCli
	});
}
function ensureAuthProfileStoreWithoutExternalProfiles(agentDir, options) {
	const effectiveOptions = {
		...options,
		resolveLegacyOAuthSidecars: options?.resolveLegacyOAuthSidecars ?? true
	};
	const runtimeStore = resolveRuntimeAuthProfileStore(agentDir, effectiveOptions);
	if (runtimeStore) return runtimeStore;
	const store = loadAuthProfileStoreForAgent(agentDir, effectiveOptions);
	const authPath = resolveAuthStorePath(agentDir);
	const mainAuthPath = resolveAuthStorePath();
	if (!agentDir || authPath === mainAuthPath) return store;
	return mergeAuthProfileStores(loadAuthProfileStoreForAgent(void 0, effectiveOptions), store);
}
function findPersistedAuthProfileCredential(params) {
	const requestedProfile = loadPersistedAuthProfileStore(params.agentDir)?.profiles[params.profileId];
	if (requestedProfile || !params.agentDir) return requestedProfile;
	if (resolveAuthStorePath(params.agentDir) === resolveAuthStorePath()) return requestedProfile;
	return loadPersistedAuthProfileStore()?.profiles[params.profileId];
}
function resolvePersistedAuthProfileOwnerAgentDir(params) {
	if (!params.agentDir) return;
	const requestedStore = loadPersistedAuthProfileStore(params.agentDir);
	if (resolveAuthStorePath(params.agentDir) === resolveAuthStorePath()) return;
	const mainStore = loadPersistedAuthProfileStore();
	const requestedProfile = requestedStore?.profiles[params.profileId];
	if (requestedProfile) return shouldUseMainOwnerForLocalOAuthCredential({
		local: requestedProfile,
		main: mainStore?.profiles[params.profileId]
	}) ? void 0 : params.agentDir;
	return mainStore?.profiles[params.profileId] ? void 0 : params.agentDir;
}
function ensureAuthProfileStoreForLocalUpdate(agentDir) {
	const store = loadAuthProfileStoreForAgent(agentDir, { syncExternalCli: false });
	const authPath = resolveAuthStorePath(agentDir);
	const mainAuthPath = resolveAuthStorePath();
	if (!agentDir || authPath === mainAuthPath) return store;
	return mergeAuthProfileStores(loadAuthProfileStoreForAgent(void 0, {
		readOnly: true,
		syncExternalCli: false
	}), store);
}
function replaceRuntimeAuthProfileStoreSnapshots(entries) {
	replaceRuntimeAuthProfileStoreSnapshots$1(entries);
}
function clearRuntimeAuthProfileStoreSnapshots() {
	clearRuntimeAuthProfileStoreSnapshots$1();
	clearLoadedAuthStoreCache();
}
function saveAuthProfileStore(store, agentDir, options) {
	const authPath = resolveAuthStorePath(agentDir);
	const statePath = resolveAuthStatePath(agentDir);
	const runtimeLegacyOAuthSidecarProfileIds = new Set(Object.entries(store.profiles).filter(([profileId, credential]) => isRuntimeLegacyOAuthSidecarCredential(credential) || matchesRuntimeLegacyOAuthSidecarMaterial({
		authPath,
		profileId,
		credential
	})).map(([profileId]) => profileId));
	const localStore = buildLocalAuthProfileStoreForSave({
		store,
		agentDir,
		options
	});
	saveJsonFile(authPath, buildPersistedAuthProfileSecretsStore(localStore, void 0, {
		existingRaw: loadJsonFile(authPath),
		runtimeLegacyOAuthSidecarProfileIds
	}));
	savePersistedAuthProfileState(localStore, agentDir);
	writeCachedAuthProfileStore({
		authPath,
		authMtimeMs: readAuthStoreMtimeMs(authPath),
		stateMtimeMs: readAuthStoreMtimeMs(statePath),
		store: localStore
	});
	if (hasRuntimeAuthProfileStoreSnapshot(agentDir)) setRuntimeAuthProfileStoreSnapshot(localStore, agentDir);
}
//#endregion
export { shouldReplaceStoredOAuthCredential as A, readManagedExternalCliCredential as C, isSafeToAdoptBootstrapOAuthIdentity as D, hasUsableOAuthCredential as E, readClaudeCliCredentialsCached as F, readCodexCliCredentialsCached as I, readGeminiCliCredentialsCached as L, evaluateStoredCredentialEligibility as M, hasUsableOAuthCredential$1 as N, isSafeToAdoptMainStoreOAuthIdentity as O, resolveTokenExpiryState as P, readExternalCliFallbackCredential as S, hasMatchingOAuthIdentity as T, isLegacyOAuthRef as _, findPersistedAuthProfileCredential as a, loadLegacyOAuthSidecarMaterial as b, loadAuthProfileStoreForSecretsRuntime as c, resolvePersistedAuthProfileOwnerAgentDir as d, saveAuthProfileStore as f, loadPersistedAuthProfileStore as g, coercePersistedAuthProfileStore as h, ensureAuthProfileStoreWithoutExternalProfiles as i, DEFAULT_OAUTH_REFRESH_MARGIN_MS as j, shouldBootstrapFromExternalCliCredential as k, loadAuthProfileStoreWithoutExternalProfiles as l, buildPersistedAuthProfileSecretsStore as m, ensureAuthProfileStore as n, loadAuthProfileStore as o, updateAuthProfileStoreWithLock as p, ensureAuthProfileStoreForLocalUpdate as r, loadAuthProfileStoreForRuntime as s, clearRuntimeAuthProfileStoreSnapshots as t, replaceRuntimeAuthProfileStoreSnapshots as u, isLegacyOAuthSidecarPayload as v, areOAuthCredentialsEquivalent as w, resolveLegacyOAuthSidecarPath as x, legacyOAuthSidecarTestUtils as y };
