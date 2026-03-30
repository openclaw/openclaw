import { st as resolveUserPath } from "./entry.js";
import { $ as secretRefKey, Cn as replaceRuntimeAuthProfileStoreSnapshots, Dn as resolveOpenClawAgentDir, I as setRuntimeConfigSnapshot, Jr as coerceSecretRef, Sn as loadAuthProfileStoreForSecretsRuntime, _ as isNonEmptyString, g as resolveSecretRefValues, k as clearRuntimeConfigSnapshot, v as isRecord, yn as clearRuntimeAuthProfileStoreSnapshots } from "./auth-profiles-D6H-HVV8.js";
import { a as resolveAgentDir, r as listAgentIds } from "./agent-scope-C2k6BQnt.js";

//#region src/secrets/runtime.ts
let activeSnapshot = null;
function cloneSnapshot(snapshot) {
	return {
		sourceConfig: structuredClone(snapshot.sourceConfig),
		config: structuredClone(snapshot.config),
		authStores: snapshot.authStores.map((entry) => ({
			agentDir: entry.agentDir,
			store: structuredClone(entry.store)
		})),
		warnings: snapshot.warnings.map((warning) => ({ ...warning }))
	};
}
function pushAssignment(context, assignment) {
	context.assignments.push(assignment);
}
function collectModelProviderAssignments(params) {
	for (const [providerId, provider] of Object.entries(params.providers)) {
		const ref = coerceSecretRef(provider.apiKey, params.defaults);
		if (!ref) continue;
		pushAssignment(params.context, {
			ref,
			path: `models.providers.${providerId}.apiKey`,
			expected: "string",
			apply: (value) => {
				provider.apiKey = value;
			}
		});
	}
}
function collectSkillAssignments(params) {
	for (const [skillKey, entry] of Object.entries(params.entries)) {
		const ref = coerceSecretRef(entry.apiKey, params.defaults);
		if (!ref) continue;
		pushAssignment(params.context, {
			ref,
			path: `skills.entries.${skillKey}.apiKey`,
			expected: "string",
			apply: (value) => {
				entry.apiKey = value;
			}
		});
	}
}
function collectGoogleChatAccountAssignment(params) {
	const explicitRef = coerceSecretRef(params.target.serviceAccountRef, params.defaults);
	const inlineRef = coerceSecretRef(params.target.serviceAccount, params.defaults);
	const ref = explicitRef ?? inlineRef;
	if (!ref) return;
	if (explicitRef && params.target.serviceAccount !== void 0 && !coerceSecretRef(params.target.serviceAccount, params.defaults)) params.context.warnings.push({
		code: "SECRETS_REF_OVERRIDES_PLAINTEXT",
		path: params.path,
		message: `${params.path}: serviceAccountRef is set; runtime will ignore plaintext serviceAccount.`
	});
	pushAssignment(params.context, {
		ref,
		path: `${params.path}.serviceAccount`,
		expected: "string-or-object",
		apply: (value) => {
			params.target.serviceAccount = value;
		}
	});
}
function collectGoogleChatAssignments(params) {
	collectGoogleChatAccountAssignment({
		target: params.googleChat,
		path: "channels.googlechat",
		defaults: params.defaults,
		context: params.context
	});
	if (!isRecord(params.googleChat.accounts)) return;
	for (const [accountId, account] of Object.entries(params.googleChat.accounts)) {
		if (!isRecord(account)) continue;
		collectGoogleChatAccountAssignment({
			target: account,
			path: `channels.googlechat.accounts.${accountId}`,
			defaults: params.defaults,
			context: params.context
		});
	}
}
function collectConfigAssignments(params) {
	const defaults = params.context.sourceConfig.secrets?.defaults;
	const providers = params.config.models?.providers;
	if (providers) collectModelProviderAssignments({
		providers,
		defaults,
		context: params.context
	});
	const skillEntries = params.config.skills?.entries;
	if (skillEntries) collectSkillAssignments({
		entries: skillEntries,
		defaults,
		context: params.context
	});
	const googleChat = params.config.channels?.googlechat;
	if (googleChat) collectGoogleChatAssignments({
		googleChat,
		defaults,
		context: params.context
	});
}
function collectApiKeyProfileAssignment(params) {
	const keyRef = coerceSecretRef(params.profile.keyRef, params.defaults);
	const inlineKeyRef = keyRef ? null : coerceSecretRef(params.profile.key, params.defaults);
	const resolvedKeyRef = keyRef ?? inlineKeyRef;
	if (!resolvedKeyRef) return;
	if (keyRef && isNonEmptyString(params.profile.key)) params.context.warnings.push({
		code: "SECRETS_REF_OVERRIDES_PLAINTEXT",
		path: `${params.agentDir}.auth-profiles.${params.profileId}.key`,
		message: `auth-profiles ${params.profileId}: keyRef is set; runtime will ignore plaintext key.`
	});
	pushAssignment(params.context, {
		ref: resolvedKeyRef,
		path: `${params.agentDir}.auth-profiles.${params.profileId}.key`,
		expected: "string",
		apply: (value) => {
			params.profile.key = String(value);
		}
	});
}
function collectTokenProfileAssignment(params) {
	const tokenRef = coerceSecretRef(params.profile.tokenRef, params.defaults);
	const inlineTokenRef = tokenRef ? null : coerceSecretRef(params.profile.token, params.defaults);
	const resolvedTokenRef = tokenRef ?? inlineTokenRef;
	if (!resolvedTokenRef) return;
	if (tokenRef && isNonEmptyString(params.profile.token)) params.context.warnings.push({
		code: "SECRETS_REF_OVERRIDES_PLAINTEXT",
		path: `${params.agentDir}.auth-profiles.${params.profileId}.token`,
		message: `auth-profiles ${params.profileId}: tokenRef is set; runtime will ignore plaintext token.`
	});
	pushAssignment(params.context, {
		ref: resolvedTokenRef,
		path: `${params.agentDir}.auth-profiles.${params.profileId}.token`,
		expected: "string",
		apply: (value) => {
			params.profile.token = String(value);
		}
	});
}
function collectAuthStoreAssignments(params) {
	const defaults = params.context.sourceConfig.secrets?.defaults;
	for (const [profileId, profile] of Object.entries(params.store.profiles)) {
		if (profile.type === "api_key") {
			collectApiKeyProfileAssignment({
				profile,
				profileId,
				agentDir: params.agentDir,
				defaults,
				context: params.context
			});
			continue;
		}
		if (profile.type === "token") collectTokenProfileAssignment({
			profile,
			profileId,
			agentDir: params.agentDir,
			defaults,
			context: params.context
		});
	}
}
function applyAssignments(params) {
	for (const assignment of params.assignments) {
		const key = secretRefKey(assignment.ref);
		if (!params.resolved.has(key)) throw new Error(`Secret reference "${key}" resolved to no value.`);
		const value = params.resolved.get(key);
		if (assignment.expected === "string") {
			if (!isNonEmptyString(value)) throw new Error(`${assignment.path} resolved to a non-string or empty value.`);
			assignment.apply(value);
			continue;
		}
		if (!(isNonEmptyString(value) || isRecord(value))) throw new Error(`${assignment.path} resolved to an unsupported value type.`);
		assignment.apply(value);
	}
}
function collectCandidateAgentDirs(config) {
	const dirs = /* @__PURE__ */ new Set();
	dirs.add(resolveUserPath(resolveOpenClawAgentDir()));
	for (const agentId of listAgentIds(config)) dirs.add(resolveUserPath(resolveAgentDir(config, agentId)));
	return [...dirs];
}
async function prepareSecretsRuntimeSnapshot(params) {
	const sourceConfig = structuredClone(params.config);
	const resolvedConfig = structuredClone(params.config);
	const context = {
		sourceConfig,
		env: params.env ?? process.env,
		cache: {},
		warnings: [],
		assignments: []
	};
	collectConfigAssignments({
		config: resolvedConfig,
		context
	});
	const loadAuthStore = params.loadAuthStore ?? loadAuthProfileStoreForSecretsRuntime;
	const candidateDirs = params.agentDirs?.length ? [...new Set(params.agentDirs.map((entry) => resolveUserPath(entry)))] : collectCandidateAgentDirs(resolvedConfig);
	const authStores = [];
	for (const agentDir of candidateDirs) {
		const store = structuredClone(loadAuthStore(agentDir));
		collectAuthStoreAssignments({
			store,
			context,
			agentDir
		});
		authStores.push({
			agentDir,
			store
		});
	}
	if (context.assignments.length > 0) {
		const resolved = await resolveSecretRefValues(context.assignments.map((assignment) => assignment.ref), {
			config: sourceConfig,
			env: context.env,
			cache: context.cache
		});
		applyAssignments({
			assignments: context.assignments,
			resolved
		});
	}
	return {
		sourceConfig,
		config: resolvedConfig,
		authStores,
		warnings: context.warnings
	};
}
function activateSecretsRuntimeSnapshot(snapshot) {
	const next = cloneSnapshot(snapshot);
	setRuntimeConfigSnapshot(next.config, next.sourceConfig);
	replaceRuntimeAuthProfileStoreSnapshots(next.authStores);
	activeSnapshot = next;
}
function getActiveSecretsRuntimeSnapshot() {
	return activeSnapshot ? cloneSnapshot(activeSnapshot) : null;
}
function clearSecretsRuntimeSnapshot() {
	activeSnapshot = null;
	clearRuntimeConfigSnapshot();
	clearRuntimeAuthProfileStoreSnapshots();
}

//#endregion
export { prepareSecretsRuntimeSnapshot as i, clearSecretsRuntimeSnapshot as n, getActiveSecretsRuntimeSnapshot as r, activateSecretsRuntimeSnapshot as t };