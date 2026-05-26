import { r as normalizeProviderId } from "./provider-id-zTW9Rdln.js";
import { n as resolveDefaultAgentWorkspaceDir } from "./workspace-default--mMaLHGD.js";
import { a as resolveAgentDir, c as resolveDefaultAgentId, n as listAgentIds, o as resolveAgentWorkspaceDir } from "./agent-scope-config-CMp71_27.js";
import { c as hashRuntimeConfigValue } from "./runtime-snapshot-DgdkBEdP.js";
import { i as ensureAuthProfileStoreWithoutExternalProfiles, n as ensureAuthProfileStore } from "./store-BMQkMM4l.js";
import "./model-selection-P-81eBKx.js";
import { n as loadModelCatalog } from "./model-catalog-DhWpNp70.js";
import "./workspace-DTx8zuCN.js";
import "./auth-profiles-D6NMnufG.js";
import { i as externalCliDiscoveryForProviders, r as externalCliDiscoveryForProviderAuth } from "./external-cli-discovery-D0JQl8du.js";
import { n as listProfilesForProvider } from "./profile-list-C0HtPlut.js";
import { r as createRuntimeProviderAuthLookup, s as hasRuntimeAvailableProviderAuth } from "./model-auth-Db-JGIrg.js";
//#region src/agents/model-provider-auth.ts
let currentProviderAuthStates = null;
const configFingerprintCache = /* @__PURE__ */ new WeakMap();
let currentProviderAuthStateGeneration = 0;
function clearCurrentProviderAuthState() {
	currentProviderAuthStates = null;
	currentProviderAuthStateGeneration += 1;
}
function resolvePreparedStateForCaller(params) {
	if (!params.states) return null;
	if (params.callerAgentId !== void 0) return params.states.get(params.callerAgentId) ?? null;
	if (!params.cfg) return null;
	return params.states.get(resolveDefaultAgentId(params.cfg)) ?? null;
}
function resolveProviderAuthConfigFingerprint(cfg) {
	if (!cfg) return null;
	const cached = configFingerprintCache.get(cfg);
	if (cached !== void 0) return cached;
	const fingerprint = hashRuntimeConfigValue(cfg);
	configFingerprintCache.set(cfg, fingerprint);
	return fingerprint;
}
async function hasAuthForModelProvider(params) {
	const provider = normalizeProviderId(params.provider);
	const preparedStates = currentProviderAuthStates;
	const workspaceDir = params.workspaceDir ?? resolveDefaultAgentWorkspaceDir();
	const configFingerprint = resolveProviderAuthConfigFingerprint(params.cfg);
	const preparedState = resolvePreparedStateForCaller({
		states: preparedStates,
		cfg: params.cfg,
		callerAgentId: params.agentId
	});
	const expectedWorkspaceDir = preparedState !== null && params.cfg ? resolveAgentWorkspaceDir(params.cfg, preparedState.agentId) : null;
	if (preparedState !== null && configFingerprint === preparedState.configFingerprint && workspaceDir === expectedWorkspaceDir && params.discoverExternalCliAuth !== false && params.allowPluginSyntheticAuth !== false && params.env === void 0 && params.store === void 0) {
		const preparedAnswer = preparedState.providers.get(provider);
		if (preparedAnswer !== void 0) return preparedAnswer;
	}
	await new Promise((resolve) => setImmediate(resolve));
	if (hasRuntimeAvailableProviderAuth({
		provider,
		cfg: params.cfg,
		workspaceDir: params.workspaceDir,
		env: params.env,
		allowPluginSyntheticAuth: params.allowPluginSyntheticAuth,
		runtimeLookup: params.runtimeAuthLookup ?? params.resolveRuntimeAuthLookup?.()
	})) return true;
	const slowPathAgentDir = params.agentId && params.cfg ? resolveAgentDir(params.cfg, params.agentId) : void 0;
	if (listProfilesForProvider(params.store ?? (params.discoverExternalCliAuth === false ? ensureAuthProfileStoreWithoutExternalProfiles(slowPathAgentDir, { allowKeychainPrompt: false }) : ensureAuthProfileStore(slowPathAgentDir, { externalCli: externalCliDiscoveryForProviderAuth({
		cfg: params.cfg,
		provider
	}) })), provider).length > 0) return true;
	return false;
}
function createProviderAuthChecker(params) {
	const authCache = /* @__PURE__ */ new Map();
	let runtimeAuthLookup;
	return async (provider) => {
		const key = normalizeProviderId(provider);
		const cached = authCache.get(key);
		if (cached !== void 0) return cached;
		const value = await hasAuthForModelProvider({
			provider: key,
			cfg: params.cfg,
			workspaceDir: params.workspaceDir,
			agentId: params.agentId,
			env: params.env,
			allowPluginSyntheticAuth: params.allowPluginSyntheticAuth,
			discoverExternalCliAuth: params.discoverExternalCliAuth,
			resolveRuntimeAuthLookup: () => runtimeAuthLookup ??= createRuntimeProviderAuthLookup({
				cfg: params.cfg,
				workspaceDir: params.workspaceDir,
				env: params.env
			})
		});
		authCache.set(key, value);
		return value;
	};
}
async function warmCurrentProviderAuthState(cfg, options = {}) {
	currentProviderAuthStateGeneration += 1;
	const ownGeneration = currentProviderAuthStateGeneration;
	const isWarmStale = () => options.isCancelled?.() === true || ownGeneration !== currentProviderAuthStateGeneration;
	const catalog = await loadModelCatalog({ config: cfg });
	if (isWarmStale()) return;
	const providers = /* @__PURE__ */ new Set();
	for (const entry of catalog) providers.add(normalizeProviderId(entry.provider));
	const providerList = [...providers];
	const configFingerprint = resolveProviderAuthConfigFingerprint(cfg) ?? "";
	const states = /* @__PURE__ */ new Map();
	for (const agentId of listAgentIds(cfg)) {
		if (isWarmStale()) return;
		const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
		const agentDir = resolveAgentDir(cfg, agentId);
		const runtimeAuthLookup = createRuntimeProviderAuthLookup({
			cfg,
			workspaceDir
		});
		const store = ensureAuthProfileStore(agentDir, {
			config: cfg,
			externalCli: externalCliDiscoveryForProviders({
				cfg,
				providers: providerList
			})
		});
		const state = /* @__PURE__ */ new Map();
		for (const provider of providers) {
			if (isWarmStale()) return;
			const value = await hasAuthForModelProvider({
				provider,
				cfg,
				workspaceDir,
				agentId,
				store,
				runtimeAuthLookup
			});
			state.set(provider, value);
		}
		states.set(agentId, {
			agentId,
			configFingerprint,
			providers: state
		});
	}
	if (options.isCancelled?.() || ownGeneration !== currentProviderAuthStateGeneration) return;
	currentProviderAuthStates = states;
}
//#endregion
export { warmCurrentProviderAuthState as i, createProviderAuthChecker as n, hasAuthForModelProvider as r, clearCurrentProviderAuthState as t };
