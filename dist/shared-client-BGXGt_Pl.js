import { u as withTimeout$1 } from "./fs-safe-CV86zY9G.js";
import { s as resolveDefaultAgentDir } from "./agent-scope-config-CMp71_27.js";
import { r as resolveProviderIdForAuth } from "./provider-auth-aliases-4jqi6Djx.js";
import { c as loadAuthProfileStoreForSecretsRuntime, d as resolvePersistedAuthProfileOwnerAgentDir, i as ensureAuthProfileStoreWithoutExternalProfiles, n as ensureAuthProfileStore } from "./store-BMQkMM4l.js";
import { n as resolveApiKeyForProfile, t as refreshOAuthCredentialForRuntime } from "./oauth--yqMDDjF.js";
import { i as resolveAuthProfileOrder } from "./order-DJrj83KE.js";
import "./agent-runtime-Lc7H-PlR.js";
import "./security-runtime-CcSekjBd.js";
import { l as resolveCodexAppServerRuntimeOptions, n as codexAppServerStartOptionsKey } from "./config-CRe1vCzw.js";
import { c as resolveCodexAppServerSpawnEnv, o as MANAGED_CODEX_APP_SERVER_PACKAGE, t as CodexAppServerClient } from "./client-Mu6OS1_O.js";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { constants, readFileSync } from "node:fs";
import path from "node:path";
import fs$1, { access } from "node:fs/promises";
import { createHash } from "node:crypto";
//#region extensions/codex/src/app-server/auth-bridge.ts
const CODEX_APP_SERVER_AUTH_PROVIDER = "openai-codex";
const OPENAI_PROVIDER = "openai";
const OPENAI_CODEX_DEFAULT_PROFILE_ID = "openai-codex:default";
const CODEX_HOME_ENV_VAR = "CODEX_HOME";
const HOME_ENV_VAR = "HOME";
const CODEX_APP_SERVER_HOME_DIRNAME = "codex-home";
const CODEX_APP_SERVER_API_KEY_ENV_VARS = ["CODEX_API_KEY", "OPENAI_API_KEY"];
const CODEX_APP_SERVER_HOME_ENV_VARS = [CODEX_HOME_ENV_VAR, HOME_ENV_VAR];
async function bridgeCodexAppServerStartOptions(params) {
	if (params.startOptions.transport !== "stdio") return params.startOptions;
	const isolatedStartOptions = await withAgentCodexHomeEnvironment(params.startOptions, params.agentDir);
	if (params.authProfileId === null) return isolatedStartOptions;
	const store = ensureCodexAppServerAuthProfileStore({
		agentDir: params.agentDir,
		authProfileId: params.authProfileId,
		config: params.config
	});
	return shouldClearOpenAiApiKeyForCodexAuthProfile({
		store,
		authProfileId: resolveCodexAppServerAuthProfileId({
			authProfileId: params.authProfileId,
			store,
			config: params.config
		}),
		config: params.config
	}) ? withClearedEnvironmentVariables(isolatedStartOptions, CODEX_APP_SERVER_API_KEY_ENV_VARS) : isolatedStartOptions;
}
function resolveCodexAppServerAuthProfileId(params) {
	const requested = params.authProfileId?.trim();
	if (requested) return requested;
	return resolveAuthProfileOrder({
		cfg: params.config,
		store: params.store,
		provider: CODEX_APP_SERVER_AUTH_PROVIDER
	})[0]?.trim();
}
function resolveCodexAppServerAuthProfileIdForAgent(params) {
	const store = ensureCodexAppServerAuthProfileStore({
		agentDir: params.agentDir?.trim() || resolveDefaultAgentDir(params.config ?? {}),
		authProfileId: params.authProfileId,
		config: params.config
	});
	return resolveCodexAppServerAuthProfileId({
		authProfileId: params.authProfileId,
		store,
		config: params.config
	});
}
function ensureCodexAppServerAuthProfileStore(params) {
	return ensureAuthProfileStore(params.agentDir, {
		allowKeychainPrompt: false,
		config: params.config,
		externalCliProviderIds: [CODEX_APP_SERVER_AUTH_PROVIDER],
		...params.authProfileId ? { externalCliProfileIds: [params.authProfileId] } : {}
	});
}
function resolveCodexAppServerAuthProfileStore(params) {
	const overlaidStore = ensureCodexAppServerAuthProfileStore({
		agentDir: params.agentDir,
		authProfileId: params.authProfileId,
		config: params.config
	});
	if (!params.authProfileStore) return overlaidStore;
	const order = params.authProfileStore.order || overlaidStore.order ? {
		...overlaidStore.order,
		...params.authProfileStore.order
	} : void 0;
	return {
		...params.authProfileStore,
		...order ? { order } : {},
		profiles: {
			...overlaidStore.profiles,
			...params.authProfileStore.profiles
		}
	};
}
async function resolveCodexAppServerAuthAccountCacheKey(params) {
	const agentDir = params.agentDir?.trim() || resolveDefaultAgentDir(params.config ?? {});
	const store = resolveCodexAppServerAuthProfileStore({
		agentDir,
		authProfileId: params.authProfileId,
		authProfileStore: params.authProfileStore,
		config: params.config
	});
	const profileId = resolveCodexAppServerAuthProfileId({
		authProfileId: params.authProfileId,
		store,
		config: params.config
	});
	if (!profileId) return;
	const credential = store.profiles[profileId];
	if (!credential || !isCodexAppServerAuthProfileCredential(credential, params.config)) return;
	if (credential.type === "api_key") {
		const apiKey = (await resolveApiKeyForProfile({
			store,
			profileId,
			agentDir
		}))?.apiKey?.trim();
		return apiKey ? `${resolveChatgptAccountId(profileId, credential)}:${fingerprintApiKeyAuthProfileCacheKey(apiKey)}` : resolveChatgptAccountId(profileId, credential);
	}
	if (credential.type === "token") {
		const accessToken = (await resolveApiKeyForProfile({
			store,
			profileId,
			agentDir
		}))?.apiKey?.trim();
		return accessToken ? `${resolveChatgptAccountId(profileId, credential)}:${fingerprintTokenAuthProfileCacheKey(accessToken)}` : resolveChatgptAccountId(profileId, credential);
	}
	return resolveChatgptAccountId(profileId, credential);
}
function resolveCodexAppServerEnvApiKeyCacheKey(params) {
	if (params.startOptions.transport !== "stdio") return;
	const apiKey = readFirstNonEmptyEnvEntry(resolveCodexAppServerSpawnEnv(params.startOptions, params.baseEnv ?? process.env, params.platform ?? process.platform), CODEX_APP_SERVER_API_KEY_ENV_VARS);
	if (!apiKey) return;
	const hash = createHash("sha256");
	hash.update("openclaw:codex:app-server-env-api-key:v1");
	hash.update("\0");
	hash.update(apiKey.key);
	hash.update("\0");
	hash.update(apiKey.value);
	return `${apiKey.key}:sha256:${hash.digest("hex")}`;
}
function fingerprintApiKeyAuthProfileCacheKey(apiKey) {
	const hash = createHash("sha256");
	hash.update("openclaw:codex:app-server-auth-profile-api-key:v1");
	hash.update("\0");
	hash.update(apiKey);
	return `api_key:sha256:${hash.digest("hex")}`;
}
function fingerprintTokenAuthProfileCacheKey(accessToken) {
	const hash = createHash("sha256");
	hash.update("openclaw:codex:app-server-auth-profile-token:v1");
	hash.update("\0");
	hash.update(accessToken);
	return `token:sha256:${hash.digest("hex")}`;
}
function resolveCodexAppServerHomeDir(agentDir) {
	return path.join(path.resolve(agentDir), CODEX_APP_SERVER_HOME_DIRNAME);
}
async function withAgentCodexHomeEnvironment(startOptions, agentDir) {
	const codexHome = startOptions.env?.[CODEX_HOME_ENV_VAR]?.trim() ? startOptions.env[CODEX_HOME_ENV_VAR] : resolveCodexAppServerHomeDir(agentDir);
	const nativeHome = startOptions.env?.[HOME_ENV_VAR]?.trim() ? startOptions.env[HOME_ENV_VAR] : void 0;
	await fs$1.mkdir(codexHome, { recursive: true });
	if (nativeHome) await fs$1.mkdir(nativeHome, { recursive: true });
	const nextStartOptions = {
		...startOptions,
		env: {
			...startOptions.env,
			[CODEX_HOME_ENV_VAR]: codexHome,
			...nativeHome ? { [HOME_ENV_VAR]: nativeHome } : {}
		}
	};
	const clearEnv = withoutClearedCodexHomeEnv(startOptions.clearEnv);
	if (clearEnv) nextStartOptions.clearEnv = clearEnv;
	else delete nextStartOptions.clearEnv;
	return nextStartOptions;
}
function withoutClearedCodexHomeEnv(clearEnv) {
	if (!clearEnv) return;
	const reserved = new Set(CODEX_APP_SERVER_HOME_ENV_VARS);
	const filtered = clearEnv.filter((envVar) => !reserved.has(envVar.trim().toUpperCase()));
	return filtered.length === clearEnv.length ? clearEnv : filtered;
}
async function applyCodexAppServerAuthProfile(params) {
	if (params.authProfileId === null) return;
	const loginParams = await resolveCodexAppServerAuthProfileLoginParams({
		agentDir: params.agentDir,
		authProfileId: params.authProfileId,
		config: params.config
	});
	if (!loginParams) {
		if (params.startOptions?.transport !== "stdio") return;
		const env = resolveCodexAppServerSpawnEnv(params.startOptions, process.env);
		const fallbackLoginParams = await resolveCodexAppServerEnvApiKeyLoginParams({
			client: params.client,
			env
		});
		if (fallbackLoginParams) await params.client.request("account/login/start", fallbackLoginParams);
		return;
	}
	await params.client.request("account/login/start", loginParams);
}
function resolveCodexAppServerAuthProfileLoginParams(params) {
	return resolveCodexAppServerAuthProfileLoginParamsInternal(params);
}
async function refreshCodexAppServerAuthTokens(params) {
	const loginParams = await resolveCodexAppServerAuthProfileLoginParamsInternal({
		...params,
		forceOAuthRefresh: true
	});
	if (!loginParams || loginParams.type !== "chatgptAuthTokens") throw new Error("Codex app-server ChatGPT token refresh requires an OAuth auth profile.");
	return {
		accessToken: loginParams.accessToken,
		chatgptAccountId: loginParams.chatgptAccountId,
		chatgptPlanType: loginParams.chatgptPlanType ?? null
	};
}
async function resolveCodexAppServerAuthProfileLoginParamsInternal(params) {
	const store = ensureCodexAppServerAuthProfileStore({
		agentDir: params.agentDir,
		authProfileId: params.authProfileId,
		config: params.config
	});
	const profileId = resolveCodexAppServerAuthProfileId({
		authProfileId: params.authProfileId,
		store,
		config: params.config
	});
	if (!profileId) return;
	const credential = store.profiles[profileId];
	if (!credential) throw new Error(`Codex app-server auth profile "${profileId}" was not found.`);
	if (!isCodexAppServerAuthProfileCredential(credential, params.config)) throw new Error(`Codex app-server auth profile "${profileId}" must be OpenAI Codex auth or an OpenAI API-key backup.`);
	const loginParams = await resolveLoginParamsForCredential(profileId, credential, {
		agentDir: params.agentDir,
		forceOAuthRefresh: params.forceOAuthRefresh === true,
		config: params.config
	});
	if (!loginParams) throw new Error(`Codex app-server auth profile "${profileId}" does not contain usable credentials.`);
	return loginParams;
}
async function resolveCodexAppServerEnvApiKeyLoginParams(params) {
	const apiKey = readFirstNonEmptyEnv(params.env, CODEX_APP_SERVER_API_KEY_ENV_VARS);
	if (!apiKey) return;
	const response = await params.client.request("account/read", { refreshToken: false });
	if (response.account || !response.requiresOpenaiAuth) return;
	return {
		type: "apiKey",
		apiKey
	};
}
async function resolveLoginParamsForCredential(profileId, credential, params) {
	if (credential.type === "api_key") {
		const apiKey = (await resolveApiKeyForProfile({
			store: ensureAuthProfileStore(params.agentDir, { allowKeychainPrompt: false }),
			profileId,
			agentDir: params.agentDir
		}))?.apiKey?.trim();
		return apiKey ? {
			type: "apiKey",
			apiKey
		} : void 0;
	}
	if (credential.type === "token") {
		const accessToken = (await resolveApiKeyForProfile({
			store: ensureAuthProfileStore(params.agentDir, { allowKeychainPrompt: false }),
			profileId,
			agentDir: params.agentDir
		}))?.apiKey?.trim();
		return accessToken ? buildChatgptAuthTokensParams(profileId, credential, accessToken) : void 0;
	}
	if (credential.type !== "oauth") return;
	const resolvedCredential = await resolveOAuthCredentialForCodexAppServer(profileId, credential, {
		agentDir: params.agentDir,
		forceRefresh: params.forceOAuthRefresh,
		config: params.config
	});
	const accessToken = resolvedCredential.access?.trim();
	return accessToken ? buildChatgptAuthTokensParams(profileId, resolvedCredential, accessToken) : void 0;
}
async function resolveOAuthCredentialForCodexAppServer(profileId, credential, params) {
	const ownerAgentDir = resolvePersistedAuthProfileOwnerAgentDir({
		agentDir: params.agentDir,
		profileId
	});
	const store = ensureCodexAppServerAuthProfileStore({
		agentDir: ownerAgentDir,
		authProfileId: profileId,
		config: params.config
	});
	const persistedCredential = ensureAuthProfileStoreWithoutExternalProfiles(ownerAgentDir, { allowKeychainPrompt: false }).profiles[profileId];
	const persistedOAuthCredential = persistedCredential?.type === "oauth" && isCodexAppServerAuthProvider(persistedCredential.provider, params.config) ? persistedCredential : void 0;
	const ownerCredential = store.profiles[profileId];
	const overlaidOAuthCredential = ownerCredential?.type === "oauth" && isCodexAppServerAuthProvider(ownerCredential.provider, params.config) ? ownerCredential : void 0;
	if (params.forceRefresh && !persistedOAuthCredential && overlaidOAuthCredential) {
		const refreshedRuntimeCredential = await refreshOAuthCredentialForRuntime({ credential: overlaidOAuthCredential });
		if (!refreshedRuntimeCredential?.access?.trim()) throw new Error(`Codex app-server auth profile "${profileId}" could not refresh.`);
		store.profiles[profileId] = refreshedRuntimeCredential;
		return refreshedRuntimeCredential;
	}
	const resolved = await resolveApiKeyForProfile({
		store,
		profileId,
		agentDir: ownerAgentDir,
		forceRefresh: params.forceRefresh && Boolean(persistedOAuthCredential)
	});
	const refreshed = loadAuthProfileStoreForSecretsRuntime(ownerAgentDir).profiles[profileId];
	const storedCredential = store.profiles[profileId];
	const candidate = refreshed?.type === "oauth" && isCodexAppServerAuthProvider(refreshed.provider, params.config) ? refreshed : storedCredential?.type === "oauth" && isCodexAppServerAuthProvider(storedCredential.provider, params.config) ? storedCredential : credential;
	return resolved?.apiKey ? {
		...candidate,
		access: resolved.apiKey
	} : candidate;
}
function isCodexAppServerAuthProvider(provider, config) {
	return resolveProviderIdForAuth(provider, { config }) === CODEX_APP_SERVER_AUTH_PROVIDER;
}
function isOpenAIApiKeyBackupCredential(credential, config) {
	return credential.type === "api_key" && resolveProviderIdForAuth(credential.provider, { config }) === OPENAI_PROVIDER;
}
function isCodexAppServerAuthProfileCredential(credential, config) {
	return isCodexAppServerAuthProvider(credential.provider, config) || isOpenAIApiKeyBackupCredential(credential, config);
}
function shouldClearOpenAiApiKeyForCodexAuthProfile(params) {
	const profileId = params.authProfileId?.trim();
	return isCodexSubscriptionCredential(profileId ? params.store.profiles[profileId] : params.store.profiles[OPENAI_CODEX_DEFAULT_PROFILE_ID], params.config);
}
function isCodexSubscriptionCredential(credential, config) {
	if (!credential || !isCodexAppServerAuthProvider(credential.provider, config)) return false;
	return credential.type === "oauth" || credential.type === "token";
}
function withClearedEnvironmentVariables(startOptions, envVars) {
	const clearEnv = startOptions.clearEnv ?? [];
	const missingEnvVars = envVars.filter((envVar) => !clearEnv.includes(envVar));
	if (missingEnvVars.length === 0) return startOptions;
	return {
		...startOptions,
		clearEnv: [...clearEnv, ...missingEnvVars]
	};
}
function readFirstNonEmptyEnv(env, keys) {
	return readFirstNonEmptyEnvEntry(env, keys)?.value;
}
function readFirstNonEmptyEnvEntry(env, keys) {
	for (const key of keys) {
		const value = env[key]?.trim();
		if (value) return {
			key,
			value
		};
	}
}
function buildChatgptAuthTokensParams(profileId, credential, accessToken) {
	return {
		type: "chatgptAuthTokens",
		accessToken,
		chatgptAccountId: resolveChatgptAccountId(profileId, credential),
		chatgptPlanType: resolveChatgptPlanType(credential)
	};
}
function resolveChatgptPlanType(credential) {
	const record = credential;
	const planType = record.chatgptPlanType ?? record.planType;
	return typeof planType === "string" && planType.trim() ? planType.trim() : null;
}
function resolveChatgptAccountId(profileId, credential) {
	if ("accountId" in credential && typeof credential.accountId === "string") {
		const accountId = credential.accountId.trim();
		if (accountId) return accountId;
	}
	return credential.email?.trim() || profileId;
}
//#endregion
//#region extensions/codex/src/app-server/managed-binary.ts
const CODEX_PLUGIN_ROOT = resolveDefaultCodexPluginRoot(path.dirname(fileURLToPath(import.meta.url)));
async function resolveManagedCodexAppServerStartOptions(startOptions, options = {}) {
	if (startOptions.transport !== "stdio" || startOptions.commandSource !== "managed") return startOptions;
	const platform = options.platform ?? process.platform;
	const paths = resolveManagedCodexAppServerPaths({
		platform,
		pluginRoot: options.pluginRoot
	});
	const pathExists = options.pathExists ?? commandPathExists;
	const commandPath = await findManagedCodexAppServerCommandPath({
		candidateCommandPaths: paths.candidateCommandPaths,
		pathExists,
		platform
	});
	return {
		...startOptions,
		command: commandPath,
		commandSource: "resolved-managed"
	};
}
function resolveManagedCodexAppServerPaths(params) {
	const platform = params.platform ?? process.platform;
	const candidateCommandPaths = resolveManagedCodexAppServerCommandCandidates(params.pluginRoot ?? CODEX_PLUGIN_ROOT, platform);
	return {
		commandPath: candidateCommandPaths[0] ?? "",
		candidateCommandPaths
	};
}
function resolveManagedCodexAppServerCommandCandidates(pluginRoot, platform) {
	const pathApi = pathForPlatform(platform);
	const commandName = platform === "win32" ? "codex.cmd" : "codex";
	const roots = resolveManagedCodexAppServerCandidateRoots(pluginRoot, platform);
	return [...new Set([...roots.map((root) => pathApi.join(root, "node_modules", ".bin", commandName)), ...resolveManagedCodexPackageBinCandidates(roots, platform)])];
}
function resolveDefaultCodexPluginRoot(moduleDir) {
	const moduleBaseName = path.basename(moduleDir);
	if (moduleBaseName === "dist" || moduleBaseName === "dist-runtime") return path.dirname(moduleDir);
	return path.resolve(moduleDir, "..", "..");
}
function resolveManagedCodexAppServerCandidateRoots(pluginRoot, platform) {
	const pathApi = pathForPlatform(platform);
	return [
		pluginRoot,
		pathApi.dirname(pluginRoot),
		pathApi.dirname(pathApi.dirname(pluginRoot)),
		isDistExtensionRoot(pluginRoot, platform) ? pathApi.dirname(pathApi.dirname(pathApi.dirname(pluginRoot))) : null
	].filter((root) => Boolean(root));
}
function resolveManagedCodexPackageBinCandidates(roots, platform) {
	if (platform === "win32") return [];
	const candidates = [];
	for (const root of roots) {
		const candidate = resolveManagedCodexPackageBinCandidate(root);
		if (candidate) candidates.push(candidate);
	}
	return candidates;
}
function resolveManagedCodexPackageBinCandidate(root) {
	try {
		const packageJsonPath = createRequire(path.join(root, "package.json")).resolve(`${MANAGED_CODEX_APP_SERVER_PACKAGE}/package.json`);
		const packageRoot = path.dirname(packageJsonPath);
		const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
		const binPath = typeof packageJson.bin === "string" ? packageJson.bin : isRecord(packageJson.bin) && typeof packageJson.bin.codex === "string" ? packageJson.bin.codex : null;
		return binPath ? path.resolve(packageRoot, binPath) : null;
	} catch {
		return null;
	}
}
function isRecord(value) {
	return typeof value === "object" && value !== null;
}
function isDistExtensionRoot(pluginRoot, platform) {
	const pathApi = pathForPlatform(platform);
	const extensionsDir = pathApi.dirname(pluginRoot);
	const distDir = pathApi.dirname(extensionsDir);
	return pathApi.basename(extensionsDir) === "extensions" && (pathApi.basename(distDir) === "dist" || pathApi.basename(distDir) === "dist-runtime");
}
function pathForPlatform(platform) {
	return platform === "win32" ? path.win32 : path.posix;
}
async function findManagedCodexAppServerCommandPath(params) {
	for (const commandPath of params.candidateCommandPaths) if (await params.pathExists(commandPath, params.platform)) return commandPath;
	throw new Error([
		`Managed Codex app-server binary was not found for ${MANAGED_CODEX_APP_SERVER_PACKAGE}.`,
		"Reinstall or update OpenClaw, or run pnpm install in a source checkout.",
		"Set plugins.entries.codex.config.appServer.command or OPENCLAW_CODEX_APP_SERVER_BIN to use a custom Codex binary."
	].join(" "));
}
async function commandPathExists(filePath, platform) {
	try {
		await access(filePath, platform === "win32" ? constants.F_OK : constants.X_OK);
		return true;
	} catch {
		return false;
	}
}
//#endregion
//#region extensions/codex/src/app-server/timeout.ts
async function withTimeout(promise, timeoutMs, timeoutMessage) {
	return await withTimeout$1(promise, timeoutMs, { message: timeoutMessage });
}
//#endregion
//#region extensions/codex/src/app-server/shared-client.ts
const SHARED_CODEX_APP_SERVER_CLIENT_STATE = Symbol.for("openclaw.codexAppServerClientState");
function getSharedCodexAppServerClientState() {
	const globalState = globalThis;
	const state = globalState[SHARED_CODEX_APP_SERVER_CLIENT_STATE];
	if (isSharedCodexAppServerClientState(state)) return state;
	const legacyState = readLegacySharedCodexAppServerClientState(state);
	const clients = /* @__PURE__ */ new Map();
	if (legacyState?.key && (legacyState.client || legacyState.promise)) {
		const legacyKey = legacyState.key;
		clients.set(legacyKey, {
			client: legacyState.client,
			promise: legacyState.promise
		});
		legacyState.client?.addCloseHandler((closedClient) => clearSharedClientEntryIfCurrent(legacyKey, closedClient));
	}
	const nextState = { clients };
	globalState[SHARED_CODEX_APP_SERVER_CLIENT_STATE] = nextState;
	return nextState;
}
function isSharedCodexAppServerClientState(value) {
	return value !== null && typeof value === "object" && value.clients instanceof Map;
}
function readLegacySharedCodexAppServerClientState(value) {
	if (value === null || typeof value !== "object") return;
	return value;
}
async function getSharedCodexAppServerClient(options) {
	const agentDir = options?.agentDir ?? resolveDefaultAgentDir(options?.config ?? {});
	const usesNativeAuth = options?.authProfileId === null;
	const requestedAuthProfileId = options?.authProfileId === null ? void 0 : options?.authProfileId;
	const authProfileId = usesNativeAuth ? void 0 : resolveCodexAppServerAuthProfileIdForAgent({
		authProfileId: requestedAuthProfileId,
		agentDir,
		config: options?.config
	});
	const startOptions = await bridgeCodexAppServerStartOptions({
		startOptions: await resolveManagedCodexAppServerStartOptions(options?.startOptions ?? resolveCodexAppServerRuntimeOptions().start),
		agentDir,
		authProfileId: usesNativeAuth ? null : authProfileId,
		config: options?.config
	});
	const key = codexAppServerStartOptionsKey(startOptions, {
		authProfileId,
		agentDir: usesNativeAuth ? void 0 : agentDir
	});
	const state = getSharedCodexAppServerClientState();
	const entry = getOrCreateSharedClientEntry(state, key);
	const sharedPromise = entry.promise ?? (entry.promise = (async () => {
		const client = CodexAppServerClient.start(startOptions);
		entry.client = client;
		client.addCloseHandler((closedClient) => clearSharedClientEntryIfCurrent(key, closedClient));
		try {
			await client.initialize();
			await applyCodexAppServerAuthProfile({
				client,
				agentDir,
				authProfileId: usesNativeAuth ? null : authProfileId,
				startOptions,
				config: options?.config
			});
			return client;
		} catch (error) {
			client.close();
			throw error;
		}
	})());
	try {
		return await withTimeout(sharedPromise, options?.timeoutMs ?? 0, "codex app-server initialize timed out");
	} catch (error) {
		const currentEntry = state.clients.get(key);
		if (currentEntry?.promise === sharedPromise) clearSharedClientEntry(key, currentEntry);
		throw error;
	}
}
async function createIsolatedCodexAppServerClient(options) {
	const agentDir = options?.agentDir ?? resolveDefaultAgentDir(options?.config ?? {});
	const usesNativeAuth = options?.authProfileId === null;
	const requestedAuthProfileId = options?.authProfileId === null ? void 0 : options?.authProfileId;
	const authProfileId = usesNativeAuth ? void 0 : resolveCodexAppServerAuthProfileIdForAgent({
		authProfileId: requestedAuthProfileId,
		agentDir,
		config: options?.config
	});
	const startOptions = await bridgeCodexAppServerStartOptions({
		startOptions: await resolveManagedCodexAppServerStartOptions(options?.startOptions ?? resolveCodexAppServerRuntimeOptions().start),
		agentDir,
		authProfileId: usesNativeAuth ? null : authProfileId,
		config: options?.config
	});
	const client = CodexAppServerClient.start(startOptions);
	const initialize = client.initialize();
	try {
		await withTimeout(initialize, options?.timeoutMs ?? 0, "codex app-server initialize timed out");
		await applyCodexAppServerAuthProfile({
			client,
			agentDir,
			authProfileId: usesNativeAuth ? null : authProfileId,
			startOptions,
			config: options?.config
		});
		return client;
	} catch (error) {
		client.close();
		initialize.catch(() => void 0);
		throw error;
	}
}
function clearSharedCodexAppServerClientIfCurrent(client) {
	if (!client) return false;
	const state = getSharedCodexAppServerClientState();
	for (const [key, entry] of state.clients) if (entry.client === client) {
		state.clients.delete(key);
		client.close();
		return true;
	}
	return false;
}
async function clearSharedCodexAppServerClientIfCurrentAndWait(client, options) {
	if (!client) return false;
	const state = getSharedCodexAppServerClientState();
	for (const [key, entry] of state.clients) if (entry.client === client) {
		state.clients.delete(key);
		await client.closeAndWait(options);
		return true;
	}
	return false;
}
async function clearSharedCodexAppServerClientAndWait(options) {
	const state = getSharedCodexAppServerClientState();
	const clients = collectSharedClients(state);
	state.clients.clear();
	await Promise.all(clients.map((client) => client.closeAndWait(options)));
}
function getOrCreateSharedClientEntry(state, key) {
	let entry = state.clients.get(key);
	if (!entry) {
		entry = {};
		state.clients.set(key, entry);
	}
	return entry;
}
function clearSharedClientEntry(key, entry) {
	const state = getSharedCodexAppServerClientState();
	if (state.clients.get(key) !== entry) return;
	state.clients.delete(key);
	entry.client?.close();
}
function clearSharedClientEntryIfCurrent(key, client) {
	const state = getSharedCodexAppServerClientState();
	if (state.clients.get(key)?.client === client) state.clients.delete(key);
}
function collectSharedClients(state) {
	return [...new Set([...state.clients.values()].map((entry) => entry.client).filter((client) => Boolean(client)))];
}
//#endregion
export { getSharedCodexAppServerClient as a, resolveCodexAppServerAuthAccountCacheKey as c, resolveCodexAppServerEnvApiKeyCacheKey as d, resolveCodexAppServerHomeDir as f, createIsolatedCodexAppServerClient as i, resolveCodexAppServerAuthProfileId as l, clearSharedCodexAppServerClientIfCurrent as n, withTimeout as o, clearSharedCodexAppServerClientIfCurrentAndWait as r, refreshCodexAppServerAuthTokens as s, clearSharedCodexAppServerClientAndWait as t, resolveCodexAppServerAuthProfileIdForAgent as u };
