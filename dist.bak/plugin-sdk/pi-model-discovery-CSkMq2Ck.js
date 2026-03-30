import { t as __exportAll } from "./rolldown-runtime-Cbj13DAv.js";
import { Dn as ensureAuthProfileStore, Xt as normalizeProviderId } from "./config-DunvA-uZ.js";
import fs from "node:fs";
import path from "node:path";
import * as PiCodingAgent from "@mariozechner/pi-coding-agent";

//#region src/agents/pi-auth-credentials.ts
function convertAuthProfileCredentialToPi(cred) {
	if (cred.type === "api_key") {
		const key = typeof cred.key === "string" ? cred.key.trim() : "";
		if (!key) return null;
		return {
			type: "api_key",
			key
		};
	}
	if (cred.type === "token") {
		const token = typeof cred.token === "string" ? cred.token.trim() : "";
		if (!token) return null;
		if (typeof cred.expires === "number" && Number.isFinite(cred.expires) && Date.now() >= cred.expires) return null;
		return {
			type: "api_key",
			key: token
		};
	}
	if (cred.type === "oauth") {
		const access = typeof cred.access === "string" ? cred.access.trim() : "";
		const refresh = typeof cred.refresh === "string" ? cred.refresh.trim() : "";
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
		const provider = normalizeProviderId(String(credential.provider ?? "")).trim();
		if (!provider || credentials[provider]) continue;
		const converted = convertAuthProfileCredentialToPi(credential);
		if (converted) credentials[provider] = converted;
	}
	return credentials;
}

//#endregion
//#region src/agents/pi-model-discovery.ts
var pi_model_discovery_exports = /* @__PURE__ */ __exportAll({
	AuthStorage: () => PiAuthStorageClass,
	ModelRegistry: () => PiModelRegistryClass,
	discoverAuthStorage: () => discoverAuthStorage,
	discoverModels: () => discoverModels
});
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
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function scrubLegacyStaticAuthJsonEntries(pathname) {
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
function resolvePiCredentials(agentDir) {
	return resolvePiCredentialMapFromStore(ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false }));
}
function discoverAuthStorage(agentDir) {
	const credentials = resolvePiCredentials(agentDir);
	const authPath = path.join(agentDir, "auth.json");
	scrubLegacyStaticAuthJsonEntries(authPath);
	return createAuthStorage(PiAuthStorageClass, authPath, credentials);
}
function discoverModels(authStorage, agentDir) {
	return new PiModelRegistryClass(authStorage, path.join(agentDir, "models.json"));
}

//#endregion
export { discoverModels as n, pi_model_discovery_exports as r, discoverAuthStorage as t };