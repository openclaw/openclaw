import { c as normalizeOptionalString } from "./string-coerce-Bje8XVt9.js";
import { c as isRecord } from "./utils-CCskKJVV.js";
import { r as normalizeProviderId } from "./provider-id-dd60CFPS.js";
import { c as loadAuthProfileStoreForSecretsRuntime, n as ensureAuthProfileStore } from "./store-kA9k3QAn.js";
import { N as resolveProviderSyntheticAuthWithPlugin, _ as normalizeProviderResolvedModelWithPlugin, a as applyProviderResolvedTransportWithPlugin, i as applyProviderResolvedModelCompatWithPlugins } from "./provider-runtime-7IfUFCM-.js";
import { b as resolveProviderEnvAuthEvidence, v as listProviderEnvAuthLookupKeys, y as resolveProviderEnvApiKeyCandidates } from "./model-auth-markers-Csuhcf6v.js";
import { t as resolveEnvApiKey } from "./model-auth-env-DAATdet0.js";
import { a as normalizeModelCompat } from "./provider-model-compat-77Mi9w2y.js";
import { t as resolveRuntimeSyntheticAuthProviderRefs } from "./synthetic-auth.runtime.js";
import fs from "node:fs";
import path from "node:path";
import * as PiCodingAgent from "@mariozechner/pi-coding-agent";
//#region src/agents/pi-auth-credentials.ts
function convertAuthProfileCredentialToPi(cred) {
	if (cred.type === "api_key") {
		const key = normalizeOptionalString(cred.key) ?? "";
		if (!key) return null;
		return {
			type: "api_key",
			key
		};
	}
	if (cred.type === "token") {
		const token = normalizeOptionalString(cred.token) ?? "";
		if (!token) return null;
		if (typeof cred.expires === "number" && Number.isFinite(cred.expires) && Date.now() >= cred.expires) return null;
		return {
			type: "api_key",
			key: token
		};
	}
	if (cred.type === "oauth") {
		const access = normalizeOptionalString(cred.access) ?? "";
		const refresh = normalizeOptionalString(cred.refresh) ?? "";
		if (!access || !refresh || !Number.isFinite(cred.expires) || cred.expires <= 0) return null;
		return {
			type: "oauth",
			access,
			refresh,
			expires: cred.expires
		};
	}
	return null;
}
function resolvePiCredentialMapFromStore(store) {
	const credentials = {};
	for (const credential of Object.values(store.profiles)) {
		const provider = normalizeProviderId(credential.provider ?? "");
		if (!provider || credentials[provider]) continue;
		const converted = convertAuthProfileCredentialToPi(credential);
		if (converted) credentials[provider] = converted;
	}
	return credentials;
}
//#endregion
//#region src/agents/pi-auth-discovery-core.ts
function addEnvBackedPiCredentials(credentials, options = {}) {
	const env = options.env ?? process.env;
	const lookupParams = {
		config: options.config,
		workspaceDir: options.workspaceDir,
		env
	};
	const candidateMap = resolveProviderEnvApiKeyCandidates(lookupParams);
	const authEvidenceMap = resolveProviderEnvAuthEvidence(lookupParams);
	const next = { ...credentials };
	for (const provider of listProviderEnvAuthLookupKeys({
		envCandidateMap: candidateMap,
		authEvidenceMap
	})) {
		if (next[provider]) continue;
		const resolved = resolveEnvApiKey(provider, env, {
			config: options.config,
			workspaceDir: options.workspaceDir,
			candidateMap,
			authEvidenceMap
		});
		if (!resolved?.apiKey) continue;
		next[provider] = {
			type: "api_key",
			key: resolved.apiKey
		};
	}
	return next;
}
function scrubLegacyStaticAuthJsonEntriesForDiscovery(pathname) {
	if (process.env.OPENCLAW_AUTH_STORE_READONLY === "1") return;
	if (!fs.existsSync(pathname)) return;
	let parsed;
	try {
		parsed = JSON.parse(fs.readFileSync(pathname, "utf8"));
	} catch {
		return;
	}
	if (!isRecord(parsed)) return;
	let changed = false;
	for (const [provider, value] of Object.entries(parsed)) {
		if (!isRecord(value)) continue;
		if (value.type !== "api_key") continue;
		delete parsed[provider];
		changed = true;
	}
	if (!changed) return;
	if (Object.keys(parsed).length === 0) {
		fs.rmSync(pathname, { force: true });
		return;
	}
	fs.writeFileSync(pathname, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
	fs.chmodSync(pathname, 384);
}
//#endregion
//#region src/agents/pi-auth-discovery.ts
function resolvePiCredentialsForDiscovery(agentDir, options) {
	const credentials = addEnvBackedPiCredentials(resolvePiCredentialMapFromStore(options?.readOnly === true ? loadAuthProfileStoreForSecretsRuntime(agentDir) : ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false })), {
		config: options?.config,
		workspaceDir: options?.workspaceDir,
		env: options?.env
	});
	for (const provider of resolveRuntimeSyntheticAuthProviderRefs()) {
		if (credentials[provider]) continue;
		const apiKey = resolveProviderSyntheticAuthWithPlugin({
			provider,
			context: {
				config: void 0,
				provider,
				providerConfig: void 0
			}
		})?.apiKey?.trim();
		if (!apiKey) continue;
		credentials[provider] = {
			type: "api_key",
			key: apiKey
		};
	}
	return credentials;
}
//#endregion
//#region src/agents/pi-model-discovery.ts
const PiAuthStorageClass = PiCodingAgent.AuthStorage;
const PiModelRegistryClass = PiCodingAgent.ModelRegistry;
function createInMemoryAuthStorageBackend(initialData) {
	let snapshot = JSON.stringify(initialData, null, 2);
	return { withLock(update) {
		const { result, next } = update(snapshot);
		if (typeof next === "string") snapshot = next;
		return result;
	} };
}
function normalizeDiscoveredPiModel(value, agentDir) {
	if (!isRecord(value)) return value;
	if (typeof value.id !== "string" || typeof value.name !== "string" || typeof value.provider !== "string") return value;
	const model = value;
	const pluginNormalized = normalizeProviderResolvedModelWithPlugin({
		provider: model.provider,
		context: {
			provider: model.provider,
			modelId: model.id,
			model,
			agentDir
		}
	}) ?? model;
	const compatNormalized = applyProviderResolvedModelCompatWithPlugins({
		provider: model.provider,
		context: {
			provider: model.provider,
			modelId: model.id,
			model: pluginNormalized,
			agentDir
		}
	}) ?? pluginNormalized;
	const transportNormalized = applyProviderResolvedTransportWithPlugin({
		provider: model.provider,
		context: {
			provider: model.provider,
			modelId: model.id,
			model: compatNormalized,
			agentDir
		}
	}) ?? compatNormalized;
	if (!isRecord(transportNormalized) || typeof transportNormalized.id !== "string" || typeof transportNormalized.name !== "string" || typeof transportNormalized.provider !== "string" || typeof transportNormalized.api !== "string") return value;
	return normalizeModelCompat(transportNormalized);
}
function instantiatePiModelRegistry(authStorage, modelsJsonPath) {
	const Registry = PiModelRegistryClass;
	if (typeof Registry.create === "function") return Registry.create(authStorage, modelsJsonPath);
	return new Registry(authStorage, modelsJsonPath);
}
function createOpenClawModelRegistry(authStorage, modelsJsonPath, agentDir, options) {
	const registry = instantiatePiModelRegistry(authStorage, modelsJsonPath);
	const getAll = registry.getAll.bind(registry);
	const getAvailable = registry.getAvailable.bind(registry);
	const find = registry.find.bind(registry);
	const providerFilter = options?.providerFilter ? normalizeProviderId(options.providerFilter) : "";
	const matchesProviderFilter = (entry) => !providerFilter || normalizeProviderId(entry.provider) === providerFilter;
	const shouldNormalize = options?.normalizeModels !== false;
	registry.getAll = () => {
		const entries = getAll().filter((entry) => matchesProviderFilter(entry));
		return shouldNormalize ? entries.map((entry) => normalizeDiscoveredPiModel(entry, agentDir)) : entries;
	};
	registry.getAvailable = () => {
		const entries = getAvailable().filter((entry) => matchesProviderFilter(entry));
		return shouldNormalize ? entries.map((entry) => normalizeDiscoveredPiModel(entry, agentDir)) : entries;
	};
	registry.find = (provider, modelId) => shouldNormalize ? normalizeDiscoveredPiModel(find(provider, modelId), agentDir) : find(provider, modelId);
	return registry;
}
function createAuthStorage(AuthStorageLike, path, creds) {
	const withInMemory = AuthStorageLike;
	if (typeof withInMemory.inMemory === "function") return withInMemory.inMemory(creds);
	const withFromStorage = AuthStorageLike;
	if (typeof withFromStorage.fromStorage === "function") {
		const backendCtor = PiCodingAgent.InMemoryAuthStorageBackend;
		const backend = typeof backendCtor === "function" ? new backendCtor() : createInMemoryAuthStorageBackend(creds);
		backend.withLock(() => ({
			result: void 0,
			next: JSON.stringify(creds, null, 2)
		}));
		return withFromStorage.fromStorage(backend);
	}
	const withFactory = AuthStorageLike;
	const withRuntimeOverride = typeof withFactory.create === "function" ? withFactory.create(path) : new AuthStorageLike(path);
	if (typeof withRuntimeOverride.setRuntimeApiKey === "function") for (const [provider, credential] of Object.entries(creds)) {
		if (credential.type === "api_key") {
			withRuntimeOverride.setRuntimeApiKey(provider, credential.key);
			continue;
		}
		withRuntimeOverride.setRuntimeApiKey(provider, credential.access);
	}
	return withRuntimeOverride;
}
function discoverAuthStorage(agentDir, options) {
	const credentials = options?.skipCredentials === true ? {} : resolvePiCredentialsForDiscovery(agentDir, options);
	const authPath = path.join(agentDir, "auth.json");
	if (options?.readOnly !== true) scrubLegacyStaticAuthJsonEntriesForDiscovery(authPath);
	return createAuthStorage(PiAuthStorageClass, authPath, credentials);
}
function discoverModels(authStorage, agentDir, options) {
	return createOpenClawModelRegistry(authStorage, path.join(agentDir, "models.json"), agentDir, options);
}
//#endregion
export { normalizeDiscoveredPiModel as a, scrubLegacyStaticAuthJsonEntriesForDiscovery as c, discoverModels as i, PiModelRegistryClass as n, resolvePiCredentialsForDiscovery as o, discoverAuthStorage as r, addEnvBackedPiCredentials as s, PiAuthStorageClass as t };
