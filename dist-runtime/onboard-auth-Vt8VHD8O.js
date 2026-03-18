import { i as init_paths, v as resolveStateDir } from "./paths-DqbqmTPe.js";
import { n as init_subsystem, t as createSubsystemLogger } from "./subsystem-CZwunM2N.js";
import { Cb as PROVIDER_ENV_VARS, f as upsertAuthProfile, mb as resolveOpenClawAgentDir, pb as QIANFAN_DEFAULT_MODEL_ID } from "./auth-profiles-DAOR1fRn.js";
import { at as normalizeSecretInput } from "./plugins-allowlist-E4LSkJ7R.js";
import { i as coerceSecretRef, o as init_types_secrets, t as DEFAULT_SECRET_PROVIDER_ALIAS } from "./types.secrets-Cu0Lz6pi.js";
import { n as applyProviderConfigWithDefaultModel, t as applyAgentDefaultModelPrimary } from "./onboard-auth.config-shared-B0GfsgVQ.js";
import fs from "node:fs";
import path from "node:path";
const CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF = `cloudflare-ai-gateway/claude-sonnet-4-5`;
const CLOUDFLARE_AI_GATEWAY_DEFAULT_CONTEXT_WINDOW = 2e5;
const CLOUDFLARE_AI_GATEWAY_DEFAULT_MAX_TOKENS = 64e3;
const CLOUDFLARE_AI_GATEWAY_DEFAULT_COST = {
	input: 3,
	output: 15,
	cacheRead: .3,
	cacheWrite: 3.75
};
function buildCloudflareAiGatewayModelDefinition(params) {
	return {
		id: params?.id?.trim() || "claude-sonnet-4-5",
		name: params?.name ?? "Claude Sonnet 4.5",
		reasoning: params?.reasoning ?? true,
		input: params?.input ?? ["text", "image"],
		cost: CLOUDFLARE_AI_GATEWAY_DEFAULT_COST,
		contextWindow: CLOUDFLARE_AI_GATEWAY_DEFAULT_CONTEXT_WINDOW,
		maxTokens: CLOUDFLARE_AI_GATEWAY_DEFAULT_MAX_TOKENS
	};
}
function resolveCloudflareAiGatewayBaseUrl(params) {
	const accountId = params.accountId.trim();
	const gatewayId = params.gatewayId.trim();
	if (!accountId || !gatewayId) return "";
	return `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/anthropic`;
}
`${QIANFAN_DEFAULT_MODEL_ID}`;
//#endregion
//#region src/commands/onboard-auth.credentials.ts
init_paths();
init_types_secrets();
const resolveAuthAgentDir = (agentDir) => agentDir ?? resolveOpenClawAgentDir();
const ENV_REF_PATTERN = /^\$\{([A-Z][A-Z0-9_]*)\}$/;
function buildEnvSecretRef(id) {
	return {
		source: "env",
		provider: DEFAULT_SECRET_PROVIDER_ALIAS,
		id
	};
}
function parseEnvSecretRef(value) {
	const match = ENV_REF_PATTERN.exec(value);
	if (!match) return null;
	return buildEnvSecretRef(match[1]);
}
function resolveProviderDefaultEnvSecretRef(provider) {
	const envVar = PROVIDER_ENV_VARS[provider]?.find((candidate) => candidate.trim().length > 0);
	if (!envVar) throw new Error(`Provider "${provider}" does not have a default env var mapping for secret-input-mode=ref.`);
	return buildEnvSecretRef(envVar);
}
function resolveApiKeySecretInput(provider, input, options) {
	const coercedRef = coerceSecretRef(input);
	if (coercedRef) return coercedRef;
	const normalized = normalizeSecretInput(input);
	const inlineEnvRef = parseEnvSecretRef(normalized);
	if (inlineEnvRef) return inlineEnvRef;
	if (options?.secretInputMode === "ref") return resolveProviderDefaultEnvSecretRef(provider);
	return normalized;
}
function buildApiKeyCredential(provider, input, metadata, options) {
	const secretInput = resolveApiKeySecretInput(provider, input, options);
	if (typeof secretInput === "string") return {
		type: "api_key",
		provider,
		key: secretInput,
		...metadata ? { metadata } : {}
	};
	return {
		type: "api_key",
		provider,
		keyRef: secretInput,
		...metadata ? { metadata } : {}
	};
}
/** Resolve real path, returning null if the target doesn't exist. */
function safeRealpathSync(dir) {
	try {
		return fs.realpathSync(path.resolve(dir));
	} catch {
		return null;
	}
}
function resolveSiblingAgentDirs(primaryAgentDir) {
	const normalized = path.resolve(primaryAgentDir);
	const parentOfAgent = path.dirname(normalized);
	const candidateAgentsRoot = path.dirname(parentOfAgent);
	const agentsRoot = path.basename(normalized) === "agent" && path.basename(candidateAgentsRoot) === "agents" ? candidateAgentsRoot : path.join(resolveStateDir(), "agents");
	const discovered = (() => {
		try {
			return fs.readdirSync(agentsRoot, { withFileTypes: true });
		} catch {
			return [];
		}
	})().filter((entry) => entry.isDirectory() || entry.isSymbolicLink()).map((entry) => path.join(agentsRoot, entry.name, "agent"));
	const seen = /* @__PURE__ */ new Set();
	const result = [];
	for (const dir of [normalized, ...discovered]) {
		const real = safeRealpathSync(dir);
		if (real && !seen.has(real)) {
			seen.add(real);
			result.push(real);
		}
	}
	return result;
}
async function writeOAuthCredentials(provider, creds, agentDir, options) {
	const profileId = `${provider}:${typeof creds.email === "string" && creds.email.trim() ? creds.email.trim() : "default"}`;
	const resolvedAgentDir = path.resolve(resolveAuthAgentDir(agentDir));
	const targetAgentDirs = options?.syncSiblingAgents ? resolveSiblingAgentDirs(resolvedAgentDir) : [resolvedAgentDir];
	const credential = {
		type: "oauth",
		provider,
		...creds
	};
	upsertAuthProfile({
		profileId,
		credential,
		agentDir: resolvedAgentDir
	});
	if (options?.syncSiblingAgents) {
		const primaryReal = safeRealpathSync(resolvedAgentDir);
		for (const targetAgentDir of targetAgentDirs) {
			const targetReal = safeRealpathSync(targetAgentDir);
			if (targetReal && primaryReal && targetReal === primaryReal) continue;
			try {
				upsertAuthProfile({
					profileId,
					credential,
					agentDir: targetAgentDir
				});
			} catch {}
		}
	}
	return profileId;
}
const LITELLM_DEFAULT_MODEL_REF = "litellm/claude-opus-4-6";
async function setCloudflareAiGatewayConfig(accountId, gatewayId, apiKey, agentDir, options) {
	upsertAuthProfile({
		profileId: "cloudflare-ai-gateway:default",
		credential: buildApiKeyCredential("cloudflare-ai-gateway", apiKey, {
			accountId: accountId.trim(),
			gatewayId: gatewayId.trim()
		}, options),
		agentDir: resolveAuthAgentDir(agentDir)
	});
}
async function setLitellmApiKey(key, agentDir, options) {
	upsertAuthProfile({
		profileId: "litellm:default",
		credential: buildApiKeyCredential("litellm", key, void 0, options),
		agentDir: resolveAuthAgentDir(agentDir)
	});
}
//#endregion
//#region src/commands/onboard-auth.config-gateways.ts
function applyCloudflareAiGatewayProviderConfig(cfg, params) {
	const models = { ...cfg.agents?.defaults?.models };
	models[CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF] = {
		...models[CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF],
		alias: models[CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF]?.alias ?? "Cloudflare AI Gateway"
	};
	const defaultModel = buildCloudflareAiGatewayModelDefinition();
	const existingProvider = cfg.models?.providers?.["cloudflare-ai-gateway"];
	const baseUrl = params?.accountId && params?.gatewayId ? resolveCloudflareAiGatewayBaseUrl({
		accountId: params.accountId,
		gatewayId: params.gatewayId
	}) : typeof existingProvider?.baseUrl === "string" ? existingProvider.baseUrl : void 0;
	if (!baseUrl) return {
		...cfg,
		agents: {
			...cfg.agents,
			defaults: {
				...cfg.agents?.defaults,
				models
			}
		}
	};
	return applyProviderConfigWithDefaultModel(cfg, {
		agentModels: models,
		providerId: "cloudflare-ai-gateway",
		api: "anthropic-messages",
		baseUrl,
		defaultModel
	});
}
function applyCloudflareAiGatewayConfig(cfg, params) {
	return applyAgentDefaultModelPrimary(applyCloudflareAiGatewayProviderConfig(cfg, params), CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF);
}
const LITELLM_DEFAULT_MODEL_ID = "claude-opus-4-6";
const LITELLM_DEFAULT_CONTEXT_WINDOW = 128e3;
const LITELLM_DEFAULT_MAX_TOKENS = 8192;
const LITELLM_DEFAULT_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
function buildLitellmModelDefinition() {
	return {
		id: LITELLM_DEFAULT_MODEL_ID,
		name: "Claude Opus 4.6",
		reasoning: true,
		input: ["text", "image"],
		cost: LITELLM_DEFAULT_COST,
		contextWindow: LITELLM_DEFAULT_CONTEXT_WINDOW,
		maxTokens: LITELLM_DEFAULT_MAX_TOKENS
	};
}
function applyLitellmProviderConfig(cfg) {
	const models = { ...cfg.agents?.defaults?.models };
	models[LITELLM_DEFAULT_MODEL_REF] = {
		...models[LITELLM_DEFAULT_MODEL_REF],
		alias: models["litellm/claude-opus-4-6"]?.alias ?? "LiteLLM"
	};
	const defaultModel = buildLitellmModelDefinition();
	const existingProvider = cfg.models?.providers?.litellm;
	return applyProviderConfigWithDefaultModel(cfg, {
		agentModels: models,
		providerId: "litellm",
		api: "openai-completions",
		baseUrl: (typeof existingProvider?.baseUrl === "string" ? existingProvider.baseUrl.trim() : "") || "http://localhost:4000",
		defaultModel,
		defaultModelId: LITELLM_DEFAULT_MODEL_ID
	});
}
function applyLitellmConfig(cfg) {
	return applyAgentDefaultModelPrimary(applyLitellmProviderConfig(cfg), LITELLM_DEFAULT_MODEL_REF);
}
//#endregion
//#region src/agents/opencode-zen-models.ts
init_subsystem();
createSubsystemLogger("opencode-zen-models");
//#endregion
export { setCloudflareAiGatewayConfig as a, LITELLM_DEFAULT_MODEL_REF as i, applyLitellmProviderConfig as n, setLitellmApiKey as o, applyCloudflareAiGatewayConfig as r, writeOAuthCredentials as s, applyLitellmConfig as t };
