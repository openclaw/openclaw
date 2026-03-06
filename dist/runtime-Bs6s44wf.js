import { y as resolveUserPath } from "./utils-BgHhhQlR.js";
import { a as resolveAgentDir, r as listAgentIds } from "./agent-scope-DcOd8osz.js";
import { Ft as resolveSecretRefValues, Lt as isNonEmptyString, Zt as clearRuntimeConfigSnapshot, _i as replaceRuntimeAuthProfileStoreSnapshots, gi as loadAuthProfileStoreForSecretsRuntime, in as setRuntimeConfigSnapshot, pi as clearRuntimeAuthProfileStoreSnapshots, xi as resolveOpenClawAgentDir } from "./model-selection-COYmqEoi.js";
import { L as resolveSecretInputRef } from "./registry-DBb6KIXY.js";
import { a as createResolverContext, c as collectCommandSecretAssignmentsFromSnapshot, i as applyResolvedAssignments, o as pushAssignment, s as pushWarning, t as collectConfigAssignments } from "./runtime-config-collectors-B1e_OiHD.js";

//#region src/secrets/runtime-auth-collectors.ts
function collectApiKeyProfileAssignment(params) {
	const { explicitRef: keyRef, inlineRef: inlineKeyRef, ref: resolvedKeyRef } = resolveSecretInputRef({
		value: params.profile.key,
		refValue: params.profile.keyRef,
		defaults: params.defaults
	});
	if (!resolvedKeyRef) return;
	if (!keyRef && inlineKeyRef) params.profile.keyRef = inlineKeyRef;
	if (keyRef && isNonEmptyString(params.profile.key)) pushWarning(params.context, {
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
	const { explicitRef: tokenRef, inlineRef: inlineTokenRef, ref: resolvedTokenRef } = resolveSecretInputRef({
		value: params.profile.token,
		refValue: params.profile.tokenRef,
		defaults: params.defaults
	});
	if (!resolvedTokenRef) return;
	if (!tokenRef && inlineTokenRef) params.profile.tokenRef = inlineTokenRef;
	if (tokenRef && isNonEmptyString(params.profile.token)) pushWarning(params.context, {
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

//#endregion
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
function collectCandidateAgentDirs(config) {
	const dirs = /* @__PURE__ */ new Set();
	dirs.add(resolveUserPath(resolveOpenClawAgentDir()));
	for (const agentId of listAgentIds(config)) dirs.add(resolveUserPath(resolveAgentDir(config, agentId)));
	return [...dirs];
}
async function prepareSecretsRuntimeSnapshot(params) {
	const sourceConfig = structuredClone(params.config);
	const resolvedConfig = structuredClone(params.config);
	const context = createResolverContext({
		sourceConfig,
		env: params.env ?? process.env
	});
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
		applyResolvedAssignments({
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
function resolveCommandSecretsFromActiveRuntimeSnapshot(params) {
	if (!activeSnapshot) throw new Error("Secrets runtime snapshot is not active.");
	if (params.targetIds.size === 0) return {
		assignments: [],
		diagnostics: [],
		inactiveRefPaths: []
	};
	const inactiveRefPaths = [...new Set(activeSnapshot.warnings.filter((warning) => warning.code === "SECRETS_REF_IGNORED_INACTIVE_SURFACE").map((warning) => warning.path))];
	const resolved = collectCommandSecretAssignmentsFromSnapshot({
		sourceConfig: activeSnapshot.sourceConfig,
		resolvedConfig: activeSnapshot.config,
		commandName: params.commandName,
		targetIds: params.targetIds,
		inactiveRefPaths: new Set(inactiveRefPaths)
	});
	return {
		assignments: resolved.assignments,
		diagnostics: resolved.diagnostics,
		inactiveRefPaths
	};
}
function clearSecretsRuntimeSnapshot() {
	activeSnapshot = null;
	clearRuntimeConfigSnapshot();
	clearRuntimeAuthProfileStoreSnapshots();
}

//#endregion
export { resolveCommandSecretsFromActiveRuntimeSnapshot as a, prepareSecretsRuntimeSnapshot as i, clearSecretsRuntimeSnapshot as n, getActiveSecretsRuntimeSnapshot as r, activateSecretsRuntimeSnapshot as t };