import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-LndEvhRk.js";
import { a as CLAUDE_CLI_PROFILE_ID } from "./store-cache-b4fi2Vpf.js";
import "./provider-auth-DDuA1OP7.js";
import "./string-coerce-runtime-C6AjCoZ-.js";
import { n as readClaudeCliCredentialsForSetup, r as readClaudeCliCredentialsForSetupNonInteractive } from "./cli-auth-seam-C7yFF4Cv.js";
import { n as CLAUDE_CLI_DEFAULT_ALLOWLIST_REFS, t as CLAUDE_CLI_BACKEND_ID } from "./cli-constants-DxXjZ6t6.js";
import "./cli-shared-B0G9zpUW.js";
//#region extensions/anthropic/cli-migration.ts
function toAnthropicModelRef(raw) {
	const trimmed = raw.trim();
	const lower = normalizeLowercaseStringOrEmpty(trimmed);
	const provider = lower.startsWith("anthropic/") ? "anthropic" : lower.startsWith(`claude-cli/`) ? CLAUDE_CLI_BACKEND_ID : "";
	if (!provider) return null;
	const modelId = trimmed.slice(provider.length + 1).trim();
	if (!normalizeLowercaseStringOrEmpty(modelId).startsWith("claude-")) return null;
	return `anthropic/${modelId}`;
}
function isRecord(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function rewriteModelSelection(model) {
	if (typeof model === "string") {
		const converted = toAnthropicModelRef(model);
		return converted ? {
			value: converted,
			primary: converted,
			runtimeRefs: [converted],
			changed: true
		} : {
			value: model,
			runtimeRefs: [],
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
		const converted = toAnthropicModelRef(current.primary);
		if (converted) {
			next.primary = converted;
			primary = converted;
			runtimeRefs.push(converted);
			changed = true;
		}
	}
	const currentFallbacks = current.fallbacks;
	if (Array.isArray(currentFallbacks)) {
		const nextFallbacks = currentFallbacks.map((entry) => {
			if (typeof entry !== "string") return entry;
			const converted = toAnthropicModelRef(entry);
			if (converted) runtimeRefs.push(converted);
			return converted ?? entry;
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
		migrated: []
	};
	const next = { ...models };
	const migrated = [];
	for (const [rawKey, value] of Object.entries(models)) {
		const converted = toAnthropicModelRef(rawKey);
		if (!converted) continue;
		if (converted === rawKey) continue;
		if (!(converted in next)) next[converted] = value;
		delete next[rawKey];
		migrated.push(converted);
	}
	return {
		value: migrated.length > 0 ? next : models,
		migrated
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
	const nextModels = seedClaudeCliAllowlist(rewrittenModels.value ?? defaults?.models ?? {}, [...rewrittenModel.runtimeRefs, ...rewrittenModels.migrated]);
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
