import { n as CLAUDE_CLI_DEFAULT_ALLOWLIST_REFS, t as CLAUDE_CLI_BACKEND_ID } from "./cli-constants-DOBc9V80.js";
//#region extensions/anthropic/config-defaults.ts
const ANTHROPIC_PROVIDER_API = "anthropic-messages";
const ANTHROPIC_API_KEY_DEFAULT_ALLOWLIST_REFS = ["anthropic/claude-haiku-4-5"];
function normalizeLowercaseStringOrEmpty(value) {
	return typeof value === "string" ? value.trim().toLowerCase() : "";
}
function normalizeProviderId(provider) {
	const normalized = normalizeLowercaseStringOrEmpty(provider);
	if (normalized === "bedrock" || normalized === "aws-bedrock") return "amazon-bedrock";
	return normalized;
}
function resolveAnthropicDefaultAuthMode(config, env) {
	const profiles = config.auth?.profiles ?? {};
	const anthropicProfiles = Object.entries(profiles).filter(([, profile]) => profile?.provider === "anthropic" || profile?.provider === "claude-cli");
	const order = [...config.auth?.order?.anthropic ?? [], ...(config.auth?.order)?.["claude-cli"] ?? []];
	for (const profileId of order) {
		const entry = profiles[profileId];
		if (!entry || entry.provider !== "anthropic" && entry.provider !== "claude-cli") continue;
		if (entry.provider === "claude-cli") return "oauth";
		if (entry.mode === "api_key") return "api_key";
		if (entry.mode === "oauth" || entry.mode === "token") return "oauth";
	}
	const hasApiKey = anthropicProfiles.some(([, profile]) => profile?.provider === "anthropic" && profile?.mode === "api_key");
	const hasOauth = anthropicProfiles.some(([, profile]) => profile?.provider === "claude-cli" || profile?.mode === "oauth" || profile?.mode === "token");
	if (hasApiKey && !hasOauth) return "api_key";
	if (hasOauth && !hasApiKey) return "oauth";
	if (env.ANTHROPIC_OAUTH_TOKEN?.trim()) return "oauth";
	if (env.ANTHROPIC_API_KEY?.trim()) return "api_key";
	return null;
}
function resolveModelPrimaryValue(value) {
	if (typeof value === "string") return value.trim() || void 0;
	const primary = value?.primary;
	if (typeof primary !== "string") return;
	return primary.trim() || void 0;
}
function resolveAnthropicPrimaryModelRef(raw) {
	if (!raw) return null;
	const trimmed = raw.trim();
	if (!trimmed) return null;
	const aliasKey = normalizeLowercaseStringOrEmpty(trimmed);
	if (aliasKey === "opus") return "anthropic/claude-opus-4-7";
	if (aliasKey === "sonnet") return "anthropic/claude-sonnet-4-6";
	return trimmed;
}
function parseProviderModelRef(raw, defaultProvider) {
	const trimmed = raw.trim();
	if (!trimmed) return null;
	const slashIndex = trimmed.indexOf("/");
	if (slashIndex <= 0) return {
		provider: defaultProvider,
		model: trimmed
	};
	const provider = trimmed.slice(0, slashIndex).trim();
	const model = trimmed.slice(slashIndex + 1).trim();
	if (!provider || !model) return null;
	return {
		provider: normalizeProviderId(provider),
		model
	};
}
function isAnthropicCacheRetentionTarget(parsed) {
	return Boolean(parsed && (parsed.provider === "anthropic" || parsed.provider === "amazon-bedrock" && normalizeLowercaseStringOrEmpty(parsed.model).includes("anthropic.claude")));
}
function usesClaudeCliModelSelection(config) {
	if (config.agents?.defaults?.agentRuntime?.id === "claude-cli") return true;
	const primary = resolveModelPrimaryValue(config.agents?.defaults?.model);
	if ((primary ? parseProviderModelRef(primary, "anthropic") : null)?.provider === "claude-cli") return true;
	return Object.keys(config.agents?.defaults?.models ?? {}).some((key) => {
		return parseProviderModelRef(key, "anthropic")?.provider === CLAUDE_CLI_BACKEND_ID;
	});
}
function toCanonicalAnthropicModelRef(ref) {
	return ref.startsWith(`claude-cli/`) ? `anthropic/${ref.slice(CLAUDE_CLI_BACKEND_ID.length + 1)}` : ref;
}
function normalizeAnthropicProviderConfig(providerConfig) {
	if (providerConfig.api || !Array.isArray(providerConfig.models) || providerConfig.models.length === 0) return providerConfig;
	return {
		...providerConfig,
		api: ANTHROPIC_PROVIDER_API
	};
}
function normalizeAnthropicProviderConfigForProvider(params) {
	const provider = normalizeProviderId(params.provider);
	if (provider !== "anthropic" && provider !== "claude-cli") return params.providerConfig;
	return normalizeAnthropicProviderConfig(params.providerConfig);
}
function applyAnthropicConfigDefaults(params) {
	const defaults = params.config.agents?.defaults;
	if (!defaults) return params.config;
	const authMode = resolveAnthropicDefaultAuthMode(params.config, params.env);
	if (!authMode) return params.config;
	let mutated = false;
	const nextDefaults = { ...defaults };
	const contextPruning = defaults.contextPruning ?? {};
	const heartbeat = defaults.heartbeat ?? {};
	if (defaults.contextPruning?.mode === void 0) {
		nextDefaults.contextPruning = {
			...contextPruning,
			mode: "cache-ttl",
			ttl: defaults.contextPruning?.ttl ?? "1h"
		};
		mutated = true;
	}
	if (defaults.heartbeat?.every === void 0) {
		nextDefaults.heartbeat = {
			...heartbeat,
			every: authMode === "oauth" ? "1h" : "30m"
		};
		mutated = true;
	}
	if (authMode === "api_key") {
		const nextModels = defaults.models ? { ...defaults.models } : {};
		let modelsMutated = false;
		for (const [key, entry] of Object.entries(nextModels)) {
			if (!isAnthropicCacheRetentionTarget(parseProviderModelRef(key, "anthropic"))) continue;
			const current = entry ?? {};
			const paramsValue = current.params ?? {};
			if (typeof paramsValue.cacheRetention === "string") continue;
			nextModels[key] = {
				...current,
				params: {
					...paramsValue,
					cacheRetention: "short"
				}
			};
			modelsMutated = true;
		}
		const primary = resolveAnthropicPrimaryModelRef(resolveModelPrimaryValue(defaults.model));
		if (primary) {
			const parsedPrimary = parseProviderModelRef(primary, "anthropic");
			if (parsedPrimary && isAnthropicCacheRetentionTarget(parsedPrimary)) {
				const key = `${parsedPrimary.provider}/${parsedPrimary.model}`;
				const current = nextModels[key] ?? {};
				const paramsValue = current.params ?? {};
				if (typeof paramsValue.cacheRetention !== "string") {
					nextModels[key] = {
						...current,
						params: {
							...paramsValue,
							cacheRetention: "short"
						}
					};
					modelsMutated = true;
				}
			}
		}
		if (Object.keys(nextModels).some((key) => isAnthropicCacheRetentionTarget(parseProviderModelRef(key, "anthropic")))) for (const ref of ANTHROPIC_API_KEY_DEFAULT_ALLOWLIST_REFS) {
			if (ref in nextModels) continue;
			nextModels[ref] = { params: { cacheRetention: "short" } };
			modelsMutated = true;
		}
		if (modelsMutated) {
			nextDefaults.models = nextModels;
			mutated = true;
		}
	}
	if (authMode === "oauth" && usesClaudeCliModelSelection(params.config)) {
		const nextModels = defaults.models ? { ...defaults.models } : {};
		let modelsMutated = false;
		for (const rawRef of CLAUDE_CLI_DEFAULT_ALLOWLIST_REFS) {
			const ref = toCanonicalAnthropicModelRef(rawRef);
			if (ref in nextModels) continue;
			nextModels[ref] = {};
			modelsMutated = true;
		}
		if (modelsMutated) {
			nextDefaults.models = nextModels;
			mutated = true;
		}
	}
	if (!mutated) return params.config;
	return {
		...params.config,
		agents: {
			...params.config.agents,
			defaults: nextDefaults
		}
	};
}
//#endregion
export { normalizeAnthropicProviderConfigForProvider as n, applyAnthropicConfigDefaults as t };
