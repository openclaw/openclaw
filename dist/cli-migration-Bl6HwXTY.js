import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { n as CLAUDE_CLI_PROFILE_ID } from "./constants-D_82oc2f.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import "./provider-auth-BtRKd5us.js";
import { n as readClaudeCliCredentialsForSetup, r as readClaudeCliCredentialsForSetupNonInteractive } from "./cli-auth-seam-CIW1ksPk.js";
import { n as CLAUDE_CLI_DEFAULT_ALLOWLIST_REFS, t as CLAUDE_CLI_BACKEND_ID } from "./cli-constants-8udILsOP.js";
import "./cli-shared-B3UhuiRU.js";
import { t as resolveClaudeCliAnthropicModelRefs } from "./claude-model-refs-Bdwap7rs.js";
//#region extensions/anthropic/cli-migration.ts
function toAnthropicModelRef(raw) {
	return resolveClaudeCliAnthropicModelRefs(raw)?.rewriteRef ?? null;
}
function toAnthropicRuntimeRefs(raw) {
	return resolveClaudeCliAnthropicModelRefs(raw)?.runtimeRefs ?? [];
}
function toAnthropicSelectedModelRef(raw) {
	const resolved = resolveClaudeCliAnthropicModelRefs(raw);
	return resolved?.rewriteRef ?? resolved?.selectedRef;
}
function isRecord(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function rewriteModelSelection(model) {
	if (typeof model === "string") {
		const runtimeRefs = toAnthropicRuntimeRefs(model);
		const converted = toAnthropicModelRef(model);
		const selectedRef = converted ?? toAnthropicSelectedModelRef(model);
		return converted ? {
			value: converted,
			primary: converted,
			runtimeRefs,
			changed: true
		} : {
			value: model,
			...selectedRef ? { primary: selectedRef } : {},
			runtimeRefs,
			changed: false
		};
	}
	if (!model || typeof model !== "object" || Array.isArray(model)) return {
		value: model,
		runtimeRefs: [],
		changed: false
	};
	const current = model;
	const next = { ...current };
	const runtimeRefs = [];
	let changed = false;
	let primary;
	if (typeof current.primary === "string") {
		runtimeRefs.push(...toAnthropicRuntimeRefs(current.primary));
		const converted = toAnthropicModelRef(current.primary);
		if (converted) {
			next.primary = converted;
			primary = converted;
			changed = true;
		} else primary = toAnthropicSelectedModelRef(current.primary);
	}
	const currentFallbacks = current.fallbacks;
	if (Array.isArray(currentFallbacks)) {
		const nextFallbacks = currentFallbacks.map((entry) => {
			if (typeof entry !== "string") return entry;
			runtimeRefs.push(...toAnthropicRuntimeRefs(entry));
			return toAnthropicModelRef(entry) ?? entry;
		});
		if (nextFallbacks.some((entry, index) => entry !== currentFallbacks[index])) {
			next.fallbacks = nextFallbacks;
			changed = true;
		}
	}
	return {
		value: changed ? next : model,
		...primary ? { primary } : {},
		runtimeRefs,
		changed
	};
}
function rewriteModelEntryMap(models) {
	if (!models) return {
		value: models,
		migrated: [],
		runtimeRefs: []
	};
	const next = { ...models };
	const migrated = [];
	const runtimeRefs = [];
	for (const [rawKey, value] of Object.entries(models)) {
		runtimeRefs.push(...toAnthropicRuntimeRefs(rawKey));
		const converted = toAnthropicModelRef(rawKey);
		if (!converted) continue;
		if (converted === rawKey) continue;
		if (!(converted in next)) next[converted] = value;
		if (normalizeLowercaseStringOrEmpty(rawKey).startsWith(`claude-cli/`)) delete next[rawKey];
		migrated.push(converted);
	}
	return {
		value: migrated.length > 0 || runtimeRefs.length > 0 ? next : models,
		migrated,
		runtimeRefs
	};
}
function seedClaudeCliAllowlist(models, selectedRefs = []) {
	const next = { ...models };
	const runtimeRefs = /* @__PURE__ */ new Set();
	for (const ref of CLAUDE_CLI_DEFAULT_ALLOWLIST_REFS) {
		const canonicalRef = toAnthropicModelRef(ref) ?? ref;
		runtimeRefs.add(canonicalRef);
	}
	for (const ref of selectedRefs) runtimeRefs.add(ref);
	for (const ref of runtimeRefs) next[ref] = modelEntryWithClaudeCliRuntime(next[ref]);
	return next;
}
function selectClaudeCliRuntime(agentRuntime) {
	const currentRuntime = agentRuntime?.id?.trim();
	if (currentRuntime && currentRuntime !== "auto") return agentRuntime;
	return {
		...agentRuntime,
		id: CLAUDE_CLI_BACKEND_ID
	};
}
function modelEntryWithClaudeCliRuntime(entry) {
	const base = isRecord(entry) ? { ...entry } : {};
	const currentRuntimeId = isRecord(base.agentRuntime) ? base.agentRuntime.id : void 0;
	const currentRuntime = typeof currentRuntimeId === "string" ? normalizeLowercaseStringOrEmpty(currentRuntimeId) : "";
	if (currentRuntime && currentRuntime !== "auto") return base;
	base.agentRuntime = {
		...isRecord(base.agentRuntime) ? base.agentRuntime : {},
		id: CLAUDE_CLI_BACKEND_ID
	};
	return base;
}
function hasClaudeCliAuth(options) {
	return Boolean(options?.allowKeychainPrompt === false ? readClaudeCliCredentialsForSetupNonInteractive() : readClaudeCliCredentialsForSetup());
}
function buildClaudeCliAuthProfiles(credential) {
	if (!credential) return [];
	if (credential.type === "oauth") return [{
		profileId: CLAUDE_CLI_PROFILE_ID,
		credential: {
			type: "oauth",
			provider: CLAUDE_CLI_BACKEND_ID,
			access: credential.access,
			refresh: credential.refresh,
			expires: credential.expires
		}
	}];
	return [{
		profileId: CLAUDE_CLI_PROFILE_ID,
		credential: {
			type: "token",
			provider: CLAUDE_CLI_BACKEND_ID,
			token: credential.token,
			expires: credential.expires
		}
	}];
}
function buildAnthropicCliMigrationResult(config, credential) {
	const defaults = config.agents?.defaults;
	const rewrittenModel = rewriteModelSelection(defaults?.model);
	const rewrittenModels = rewriteModelEntryMap(defaults?.models);
	const nextModels = seedClaudeCliAllowlist(rewrittenModels.value ?? defaults?.models ?? {}, [
		...rewrittenModel.runtimeRefs,
		...rewrittenModels.runtimeRefs,
		...rewrittenModels.migrated
	]);
	const defaultModel = rewrittenModel.primary ?? "anthropic/claude-opus-4-7";
	return {
		profiles: buildClaudeCliAuthProfiles(credential),
		configPatch: { agents: { defaults: {
			...rewrittenModel.changed ? { model: rewrittenModel.value } : {},
			agentRuntime: selectClaudeCliRuntime(defaults?.agentRuntime),
			models: nextModels
		} } },
		replaceDefaultModels: true,
		defaultModel,
		notes: [
			"Claude CLI auth detected; kept Anthropic model refs and selected the local Claude CLI runtime.",
			"Existing Anthropic auth profiles are kept for rollback.",
			...rewrittenModels.migrated.length > 0 ? [`Migrated allowlist entries: ${rewrittenModels.migrated.join(", ")}.`] : []
		]
	};
}
//#endregion
export { hasClaudeCliAuth as n, buildAnthropicCliMigrationResult as t };
