import { t as createSubsystemLogger } from "./subsystem-DVwhOlEq.js";
import { g as resolveStateDir } from "./paths-BfR2LXbA.js";
import { $_ as buildKimiCodingProvider, Av as DEFAULT_PROVIDER, Cv as CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF, Dv as normalizeSecretInput, F as resolveModelRefFromString, Hg as readConfigFileSnapshot, Kg as writeConfigFile, O as normalizeProviderId, Pg as resolveOpenClawAgentDir, Q_ as buildKilocodeProvider, Sv as KILOCODE_DEFAULT_MODEL_REF, T as modelKey, Tv as resolveCloudflareAiGatewayBaseUrl, X_ as QIANFAN_DEFAULT_MODEL_ID, Z_ as XIAOMI_DEFAULT_MODEL_ID, av as SYNTHETIC_BASE_URL, b as buildModelAliasIndex, cv as buildSyntheticModelDefinition, dv as VENICE_MODEL_CATALOG, ev as buildQianfanProvider, f as upsertAuthProfile, fv as buildVeniceModelDefinition, hv as buildHuggingfaceModelDefinition, iv as buildTogetherModelDefinition, lv as VENICE_BASE_URL, mv as HUGGINGFACE_MODEL_CATALOG, nv as TOGETHER_BASE_URL, ov as SYNTHETIC_DEFAULT_MODEL_REF, pv as HUGGINGFACE_BASE_URL, rv as TOGETHER_MODEL_CATALOG, sv as SYNTHETIC_MODEL_CATALOG, tv as buildXiaomiProvider, uv as VENICE_DEFAULT_MODEL_REF, w as legacyModelKey, wv as buildCloudflareAiGatewayModelDefinition, xv as KILOCODE_BASE_URL } from "./auth-profiles-CAw5gP6f.js";
import { t as formatCliCommand } from "./command-format-CO3N-oGG.js";
import { F as toAgentModelListLike, r as listAgentIds } from "./agent-scope-DBEC2O3x.js";
import { c as normalizeAgentId } from "./session-key-GuEQvqMH.js";
import { i as coerceSecretRef, t as DEFAULT_SECRET_PROVIDER_ALIAS } from "./types.secrets-CQ90JO4F.js";
import { i as isWSLEnv } from "./fetch-ZNxqGXAR.js";
import { t as PROVIDER_ENV_VARS } from "./provider-env-vars-DW9Ss6dw.js";
import { n as formatConfigIssueLines } from "./issue-format-jHeRIpoa.js";
import path from "node:path";
import fs from "node:fs";
//#region src/commands/models/shared.ts
const ensureFlagCompatibility = (opts) => {
	if (opts.json && opts.plain) throw new Error("Choose either --json or --plain, not both.");
};
const formatTokenK = (value) => {
	if (!value || !Number.isFinite(value)) return "-";
	if (value < 1024) return `${Math.round(value)}`;
	return `${Math.round(value / 1024)}k`;
};
const formatMs = (value) => {
	if (value === null || value === void 0) return "-";
	if (!Number.isFinite(value)) return "-";
	if (value < 1e3) return `${Math.round(value)}ms`;
	return `${Math.round(value / 100) / 10}s`;
};
const isLocalBaseUrl = (baseUrl) => {
	try {
		const host = new URL(baseUrl).hostname.toLowerCase();
		return host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1" || host.endsWith(".local");
	} catch {
		return false;
	}
};
async function loadValidConfigOrThrow() {
	const snapshot = await readConfigFileSnapshot();
	if (!snapshot.valid) {
		const issues = formatConfigIssueLines(snapshot.issues, "-").join("\n");
		throw new Error(`Invalid config at ${snapshot.path}\n${issues}`);
	}
	return snapshot.config;
}
async function updateConfig(mutator) {
	const next = mutator(await loadValidConfigOrThrow());
	await writeConfigFile(next);
	return next;
}
function resolveModelTarget(params) {
	const aliasIndex = buildModelAliasIndex({
		cfg: params.cfg,
		defaultProvider: DEFAULT_PROVIDER
	});
	const resolved = resolveModelRefFromString({
		raw: params.raw,
		defaultProvider: DEFAULT_PROVIDER,
		aliasIndex
	});
	if (!resolved) throw new Error(`Invalid model reference: ${params.raw}`);
	return resolved.ref;
}
function resolveModelKeysFromEntries(params) {
	const aliasIndex = buildModelAliasIndex({
		cfg: params.cfg,
		defaultProvider: DEFAULT_PROVIDER
	});
	return params.entries.map((entry) => resolveModelRefFromString({
		raw: entry,
		defaultProvider: DEFAULT_PROVIDER,
		aliasIndex
	})).filter((entry) => Boolean(entry)).map((entry) => modelKey(entry.ref.provider, entry.ref.model));
}
function normalizeAlias(alias) {
	const trimmed = alias.trim();
	if (!trimmed) throw new Error("Alias cannot be empty.");
	if (!/^[A-Za-z0-9_.:-]+$/.test(trimmed)) throw new Error("Alias must use letters, numbers, dots, underscores, colons, or dashes.");
	return trimmed;
}
function resolveKnownAgentId(params) {
	const raw = params.rawAgentId?.trim();
	if (!raw) return;
	const agentId = normalizeAgentId(raw);
	if (!listAgentIds(params.cfg).includes(agentId)) throw new Error(`Unknown agent id "${raw}". Use "${formatCliCommand("openclaw agents list")}" to see configured agents.`);
	return agentId;
}
function upsertCanonicalModelConfigEntry(models, params) {
	const key = modelKey(params.provider, params.model);
	const legacyKey = legacyModelKey(params.provider, params.model);
	if (!models[key]) if (legacyKey && models[legacyKey]) models[key] = models[legacyKey];
	else models[key] = {};
	if (legacyKey) delete models[legacyKey];
	return key;
}
function mergePrimaryFallbackConfig(existing, patch) {
	const next = { ...existing && typeof existing === "object" ? existing : void 0 };
	if (patch.primary !== void 0) next.primary = patch.primary;
	if (patch.fallbacks !== void 0) next.fallbacks = patch.fallbacks;
	return next;
}
function applyDefaultModelPrimaryUpdate(params) {
	const resolved = resolveModelTarget({
		raw: params.modelRaw,
		cfg: params.cfg
	});
	const nextModels = { ...params.cfg.agents?.defaults?.models };
	const key = upsertCanonicalModelConfigEntry(nextModels, resolved);
	const defaults = params.cfg.agents?.defaults ?? {};
	const existing = toAgentModelListLike(defaults[params.field]);
	return {
		...params.cfg,
		agents: {
			...params.cfg.agents,
			defaults: {
				...defaults,
				[params.field]: mergePrimaryFallbackConfig(existing, { primary: key }),
				models: nextModels
			}
		}
	};
}
/**
* Model key format: "provider/model"
*
* The model key is displayed in `/model status` and used to reference models.
* When using `/model <key>`, use the exact format shown (e.g., "openrouter/moonshotai/kimi-k2").
*
* For providers with hierarchical model IDs (e.g., OpenRouter), the model ID may include
* sub-providers (e.g., "moonshotai/kimi-k2"), resulting in a key like "openrouter/moonshotai/kimi-k2".
*/
//#endregion
//#region src/commands/onboard-auth.models.ts
const MINIMAX_API_BASE_URL = "https://api.minimax.io/anthropic";
const MINIMAX_CN_API_BASE_URL = "https://api.minimaxi.com/anthropic";
const DEFAULT_MINIMAX_CONTEXT_WINDOW = 2e5;
const DEFAULT_MINIMAX_MAX_TOKENS = 8192;
const MOONSHOT_BASE_URL = "https://api.moonshot.ai/v1";
const MOONSHOT_CN_BASE_URL = "https://api.moonshot.cn/v1";
const MOONSHOT_DEFAULT_MODEL_ID = "kimi-k2.5";
const MOONSHOT_DEFAULT_MODEL_REF = `moonshot/${MOONSHOT_DEFAULT_MODEL_ID}`;
const MOONSHOT_DEFAULT_CONTEXT_WINDOW = 256e3;
const MOONSHOT_DEFAULT_MAX_TOKENS = 8192;
const KIMI_CODING_MODEL_ID = "k2p5";
const KIMI_CODING_MODEL_REF = `kimi-coding/${KIMI_CODING_MODEL_ID}`;
const QIANFAN_DEFAULT_MODEL_REF = `qianfan/${QIANFAN_DEFAULT_MODEL_ID}`;
const ZAI_CODING_GLOBAL_BASE_URL = "https://api.z.ai/api/coding/paas/v4";
const ZAI_CODING_CN_BASE_URL = "https://open.bigmodel.cn/api/coding/paas/v4";
const ZAI_GLOBAL_BASE_URL = "https://api.z.ai/api/paas/v4";
const ZAI_CN_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
function resolveZaiBaseUrl(endpoint) {
	switch (endpoint) {
		case "coding-cn": return ZAI_CODING_CN_BASE_URL;
		case "global": return ZAI_GLOBAL_BASE_URL;
		case "cn": return ZAI_CN_BASE_URL;
		case "coding-global": return ZAI_CODING_GLOBAL_BASE_URL;
		default: return ZAI_GLOBAL_BASE_URL;
	}
}
const MINIMAX_API_COST = {
	input: .3,
	output: 1.2,
	cacheRead: .03,
	cacheWrite: .12
};
const MOONSHOT_DEFAULT_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
const ZAI_DEFAULT_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
const MINIMAX_MODEL_CATALOG = {
	"MiniMax-M2.5": {
		name: "MiniMax M2.5",
		reasoning: true
	},
	"MiniMax-M2.5-highspeed": {
		name: "MiniMax M2.5 Highspeed",
		reasoning: true
	}
};
const ZAI_MODEL_CATALOG = {
	"glm-5": {
		name: "GLM-5",
		reasoning: true
	},
	"glm-4.7": {
		name: "GLM-4.7",
		reasoning: true
	},
	"glm-4.7-flash": {
		name: "GLM-4.7 Flash",
		reasoning: true
	},
	"glm-4.7-flashx": {
		name: "GLM-4.7 FlashX",
		reasoning: true
	}
};
function buildMinimaxModelDefinition(params) {
	const catalog = MINIMAX_MODEL_CATALOG[params.id];
	return {
		id: params.id,
		name: params.name ?? catalog?.name ?? `MiniMax ${params.id}`,
		reasoning: params.reasoning ?? catalog?.reasoning ?? false,
		input: ["text"],
		cost: params.cost,
		contextWindow: params.contextWindow,
		maxTokens: params.maxTokens
	};
}
function buildMinimaxApiModelDefinition(modelId) {
	return buildMinimaxModelDefinition({
		id: modelId,
		cost: MINIMAX_API_COST,
		contextWindow: DEFAULT_MINIMAX_CONTEXT_WINDOW,
		maxTokens: DEFAULT_MINIMAX_MAX_TOKENS
	});
}
function buildMoonshotModelDefinition() {
	return {
		id: MOONSHOT_DEFAULT_MODEL_ID,
		name: "Kimi K2.5",
		reasoning: false,
		input: ["text", "image"],
		cost: MOONSHOT_DEFAULT_COST,
		contextWindow: MOONSHOT_DEFAULT_CONTEXT_WINDOW,
		maxTokens: MOONSHOT_DEFAULT_MAX_TOKENS
	};
}
const MISTRAL_BASE_URL = "https://api.mistral.ai/v1";
const MISTRAL_DEFAULT_MODEL_ID = "mistral-large-latest";
const MISTRAL_DEFAULT_MODEL_REF = `mistral/${MISTRAL_DEFAULT_MODEL_ID}`;
const MISTRAL_DEFAULT_CONTEXT_WINDOW = 262144;
const MISTRAL_DEFAULT_MAX_TOKENS = 262144;
const MISTRAL_DEFAULT_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
function buildMistralModelDefinition() {
	return {
		id: MISTRAL_DEFAULT_MODEL_ID,
		name: "Mistral Large",
		reasoning: false,
		input: ["text", "image"],
		cost: MISTRAL_DEFAULT_COST,
		contextWindow: MISTRAL_DEFAULT_CONTEXT_WINDOW,
		maxTokens: MISTRAL_DEFAULT_MAX_TOKENS
	};
}
function buildZaiModelDefinition(params) {
	const catalog = ZAI_MODEL_CATALOG[params.id];
	return {
		id: params.id,
		name: params.name ?? catalog?.name ?? `GLM ${params.id}`,
		reasoning: params.reasoning ?? catalog?.reasoning ?? true,
		input: ["text"],
		cost: params.cost ?? ZAI_DEFAULT_COST,
		contextWindow: params.contextWindow ?? 204800,
		maxTokens: params.maxTokens ?? 131072
	};
}
const XAI_BASE_URL = "https://api.x.ai/v1";
const XAI_DEFAULT_MODEL_ID = "grok-4";
const XAI_DEFAULT_MODEL_REF = `xai/${XAI_DEFAULT_MODEL_ID}`;
const XAI_DEFAULT_CONTEXT_WINDOW = 131072;
const XAI_DEFAULT_MAX_TOKENS = 8192;
const XAI_DEFAULT_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
function buildXaiModelDefinition() {
	return {
		id: XAI_DEFAULT_MODEL_ID,
		name: "Grok 4",
		reasoning: false,
		input: ["text"],
		cost: XAI_DEFAULT_COST,
		contextWindow: XAI_DEFAULT_CONTEXT_WINDOW,
		maxTokens: XAI_DEFAULT_MAX_TOKENS
	};
}
const MODELSTUDIO_CN_BASE_URL = "https://coding.dashscope.aliyuncs.com/v1";
const MODELSTUDIO_GLOBAL_BASE_URL = "https://coding-intl.dashscope.aliyuncs.com/v1";
const MODELSTUDIO_DEFAULT_MODEL_REF = `modelstudio/qwen3.5-plus`;
const MODELSTUDIO_DEFAULT_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
const MODELSTUDIO_MODEL_CATALOG = {
	"qwen3.5-plus": {
		name: "qwen3.5-plus",
		reasoning: false,
		input: ["text", "image"],
		contextWindow: 1e6,
		maxTokens: 65536
	},
	"qwen3-max-2026-01-23": {
		name: "qwen3-max-2026-01-23",
		reasoning: false,
		input: ["text"],
		contextWindow: 262144,
		maxTokens: 65536
	},
	"qwen3-coder-next": {
		name: "qwen3-coder-next",
		reasoning: false,
		input: ["text"],
		contextWindow: 262144,
		maxTokens: 65536
	},
	"qwen3-coder-plus": {
		name: "qwen3-coder-plus",
		reasoning: false,
		input: ["text"],
		contextWindow: 1e6,
		maxTokens: 65536
	},
	"MiniMax-M2.5": {
		name: "MiniMax-M2.5",
		reasoning: false,
		input: ["text"],
		contextWindow: 1e6,
		maxTokens: 65536
	},
	"glm-5": {
		name: "glm-5",
		reasoning: false,
		input: ["text"],
		contextWindow: 202752,
		maxTokens: 16384
	},
	"glm-4.7": {
		name: "glm-4.7",
		reasoning: false,
		input: ["text"],
		contextWindow: 202752,
		maxTokens: 16384
	},
	"kimi-k2.5": {
		name: "kimi-k2.5",
		reasoning: false,
		input: ["text", "image"],
		contextWindow: 262144,
		maxTokens: 32768
	}
};
function buildModelStudioModelDefinition(params) {
	const catalog = MODELSTUDIO_MODEL_CATALOG[params.id];
	return {
		id: params.id,
		name: params.name ?? catalog?.name ?? params.id,
		reasoning: params.reasoning ?? catalog?.reasoning ?? false,
		input: params.input ?? [...catalog?.input ?? ["text"]],
		cost: params.cost ?? MODELSTUDIO_DEFAULT_COST,
		contextWindow: params.contextWindow ?? catalog?.contextWindow ?? 262144,
		maxTokens: params.maxTokens ?? catalog?.maxTokens ?? 65536
	};
}
//#endregion
//#region src/commands/onboard-auth.credentials.ts
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
async function setAnthropicApiKey(key, agentDir, options) {
	upsertAuthProfile({
		profileId: "anthropic:default",
		credential: buildApiKeyCredential("anthropic", key, void 0, options),
		agentDir: resolveAuthAgentDir(agentDir)
	});
}
async function setOpenaiApiKey(key, agentDir, options) {
	upsertAuthProfile({
		profileId: "openai:default",
		credential: buildApiKeyCredential("openai", key, void 0, options),
		agentDir: resolveAuthAgentDir(agentDir)
	});
}
async function setGeminiApiKey(key, agentDir, options) {
	upsertAuthProfile({
		profileId: "google:default",
		credential: buildApiKeyCredential("google", key, void 0, options),
		agentDir: resolveAuthAgentDir(agentDir)
	});
}
async function setMinimaxApiKey(key, agentDir, profileId = "minimax:default", options) {
	upsertAuthProfile({
		profileId,
		credential: buildApiKeyCredential(profileId.split(":")[0] ?? "minimax", key, void 0, options),
		agentDir: resolveAuthAgentDir(agentDir)
	});
}
async function setMoonshotApiKey(key, agentDir, options) {
	upsertAuthProfile({
		profileId: "moonshot:default",
		credential: buildApiKeyCredential("moonshot", key, void 0, options),
		agentDir: resolveAuthAgentDir(agentDir)
	});
}
async function setKimiCodingApiKey(key, agentDir, options) {
	upsertAuthProfile({
		profileId: "kimi-coding:default",
		credential: buildApiKeyCredential("kimi-coding", key, void 0, options),
		agentDir: resolveAuthAgentDir(agentDir)
	});
}
async function setVolcengineApiKey(key, agentDir, options) {
	upsertAuthProfile({
		profileId: "volcengine:default",
		credential: buildApiKeyCredential("volcengine", key, void 0, options),
		agentDir: resolveAuthAgentDir(agentDir)
	});
}
async function setByteplusApiKey(key, agentDir, options) {
	upsertAuthProfile({
		profileId: "byteplus:default",
		credential: buildApiKeyCredential("byteplus", key, void 0, options),
		agentDir: resolveAuthAgentDir(agentDir)
	});
}
async function setSyntheticApiKey(key, agentDir, options) {
	upsertAuthProfile({
		profileId: "synthetic:default",
		credential: buildApiKeyCredential("synthetic", key, void 0, options),
		agentDir: resolveAuthAgentDir(agentDir)
	});
}
async function setVeniceApiKey(key, agentDir, options) {
	upsertAuthProfile({
		profileId: "venice:default",
		credential: buildApiKeyCredential("venice", key, void 0, options),
		agentDir: resolveAuthAgentDir(agentDir)
	});
}
const ZAI_DEFAULT_MODEL_REF = "zai/glm-5";
const XIAOMI_DEFAULT_MODEL_REF = "xiaomi/mimo-v2-flash";
const OPENROUTER_DEFAULT_MODEL_REF = "openrouter/auto";
const HUGGINGFACE_DEFAULT_MODEL_REF = "huggingface/deepseek-ai/DeepSeek-R1";
const TOGETHER_DEFAULT_MODEL_REF = "together/moonshotai/Kimi-K2.5";
const LITELLM_DEFAULT_MODEL_REF = "litellm/claude-opus-4-6";
const VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF = "vercel-ai-gateway/anthropic/claude-opus-4.6";
async function setZaiApiKey(key, agentDir, options) {
	upsertAuthProfile({
		profileId: "zai:default",
		credential: buildApiKeyCredential("zai", key, void 0, options),
		agentDir: resolveAuthAgentDir(agentDir)
	});
}
async function setXiaomiApiKey(key, agentDir, options) {
	upsertAuthProfile({
		profileId: "xiaomi:default",
		credential: buildApiKeyCredential("xiaomi", key, void 0, options),
		agentDir: resolveAuthAgentDir(agentDir)
	});
}
async function setOpenrouterApiKey(key, agentDir, options) {
	upsertAuthProfile({
		profileId: "openrouter:default",
		credential: buildApiKeyCredential("openrouter", typeof key === "string" && key === "undefined" ? "" : key, void 0, options),
		agentDir: resolveAuthAgentDir(agentDir)
	});
}
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
async function setVercelAiGatewayApiKey(key, agentDir, options) {
	upsertAuthProfile({
		profileId: "vercel-ai-gateway:default",
		credential: buildApiKeyCredential("vercel-ai-gateway", key, void 0, options),
		agentDir: resolveAuthAgentDir(agentDir)
	});
}
async function setOpencodeZenApiKey(key, agentDir, options) {
	await setSharedOpencodeApiKey(key, agentDir, options);
}
async function setOpencodeGoApiKey(key, agentDir, options) {
	await setSharedOpencodeApiKey(key, agentDir, options);
}
async function setSharedOpencodeApiKey(key, agentDir, options) {
	const resolvedAgentDir = resolveAuthAgentDir(agentDir);
	for (const provider of ["opencode", "opencode-go"]) upsertAuthProfile({
		profileId: `${provider}:default`,
		credential: buildApiKeyCredential(provider, key, void 0, options),
		agentDir: resolvedAgentDir
	});
}
async function setTogetherApiKey(key, agentDir, options) {
	upsertAuthProfile({
		profileId: "together:default",
		credential: buildApiKeyCredential("together", key, void 0, options),
		agentDir: resolveAuthAgentDir(agentDir)
	});
}
async function setHuggingfaceApiKey(key, agentDir, options) {
	upsertAuthProfile({
		profileId: "huggingface:default",
		credential: buildApiKeyCredential("huggingface", key, void 0, options),
		agentDir: resolveAuthAgentDir(agentDir)
	});
}
function setQianfanApiKey(key, agentDir, options) {
	upsertAuthProfile({
		profileId: "qianfan:default",
		credential: buildApiKeyCredential("qianfan", key, void 0, options),
		agentDir: resolveAuthAgentDir(agentDir)
	});
}
function setModelStudioApiKey(key, agentDir, options) {
	upsertAuthProfile({
		profileId: "modelstudio:default",
		credential: buildApiKeyCredential("modelstudio", key, void 0, options),
		agentDir: resolveAuthAgentDir(agentDir)
	});
}
function setXaiApiKey(key, agentDir, options) {
	upsertAuthProfile({
		profileId: "xai:default",
		credential: buildApiKeyCredential("xai", key, void 0, options),
		agentDir: resolveAuthAgentDir(agentDir)
	});
}
async function setMistralApiKey(key, agentDir, options) {
	upsertAuthProfile({
		profileId: "mistral:default",
		credential: buildApiKeyCredential("mistral", key, void 0, options),
		agentDir: resolveAuthAgentDir(agentDir)
	});
}
async function setKilocodeApiKey(key, agentDir, options) {
	upsertAuthProfile({
		profileId: "kilocode:default",
		credential: buildApiKeyCredential("kilocode", key, void 0, options),
		agentDir: resolveAuthAgentDir(agentDir)
	});
}
//#endregion
//#region src/commands/onboard-auth.config-shared.ts
function extractAgentDefaultModelFallbacks(model) {
	if (!model || typeof model !== "object") return;
	if (!("fallbacks" in model)) return;
	const fallbacks = model.fallbacks;
	return Array.isArray(fallbacks) ? fallbacks.map((v) => String(v)) : void 0;
}
function applyOnboardAuthAgentModelsAndProviders(cfg, params) {
	return {
		...cfg,
		agents: {
			...cfg.agents,
			defaults: {
				...cfg.agents?.defaults,
				models: params.agentModels
			}
		},
		models: {
			mode: cfg.models?.mode ?? "merge",
			providers: params.providers
		}
	};
}
function applyAgentDefaultModelPrimary(cfg, primary) {
	const existingFallbacks = extractAgentDefaultModelFallbacks(cfg.agents?.defaults?.model);
	return {
		...cfg,
		agents: {
			...cfg.agents,
			defaults: {
				...cfg.agents?.defaults,
				model: {
					...existingFallbacks ? { fallbacks: existingFallbacks } : void 0,
					primary
				}
			}
		}
	};
}
function applyProviderConfigWithDefaultModels(cfg, params) {
	const providerState = resolveProviderModelMergeState(cfg, params.providerId);
	const defaultModels = params.defaultModels;
	const defaultModelId = params.defaultModelId ?? defaultModels[0]?.id;
	const hasDefaultModel = defaultModelId ? providerState.existingModels.some((model) => model.id === defaultModelId) : true;
	const mergedModels = providerState.existingModels.length > 0 ? hasDefaultModel || defaultModels.length === 0 ? providerState.existingModels : [...providerState.existingModels, ...defaultModels] : defaultModels;
	return applyProviderConfigWithMergedModels(cfg, {
		agentModels: params.agentModels,
		providerId: params.providerId,
		providerState,
		api: params.api,
		baseUrl: params.baseUrl,
		mergedModels,
		fallbackModels: defaultModels
	});
}
function applyProviderConfigWithDefaultModel(cfg, params) {
	return applyProviderConfigWithDefaultModels(cfg, {
		agentModels: params.agentModels,
		providerId: params.providerId,
		api: params.api,
		baseUrl: params.baseUrl,
		defaultModels: [params.defaultModel],
		defaultModelId: params.defaultModelId ?? params.defaultModel.id
	});
}
function applyProviderConfigWithModelCatalog(cfg, params) {
	const providerState = resolveProviderModelMergeState(cfg, params.providerId);
	const catalogModels = params.catalogModels;
	const mergedModels = providerState.existingModels.length > 0 ? [...providerState.existingModels, ...catalogModels.filter((model) => !providerState.existingModels.some((existing) => existing.id === model.id))] : catalogModels;
	return applyProviderConfigWithMergedModels(cfg, {
		agentModels: params.agentModels,
		providerId: params.providerId,
		providerState,
		api: params.api,
		baseUrl: params.baseUrl,
		mergedModels,
		fallbackModels: catalogModels
	});
}
function resolveProviderModelMergeState(cfg, providerId) {
	const providers = { ...cfg.models?.providers };
	const existingProvider = providers[providerId];
	return {
		providers,
		existingProvider,
		existingModels: Array.isArray(existingProvider?.models) ? existingProvider.models : []
	};
}
function applyProviderConfigWithMergedModels(cfg, params) {
	params.providerState.providers[params.providerId] = buildProviderConfig({
		existingProvider: params.providerState.existingProvider,
		api: params.api,
		baseUrl: params.baseUrl,
		mergedModels: params.mergedModels,
		fallbackModels: params.fallbackModels
	});
	return applyOnboardAuthAgentModelsAndProviders(cfg, {
		agentModels: params.agentModels,
		providers: params.providerState.providers
	});
}
function buildProviderConfig(params) {
	const { apiKey: existingApiKey, ...existingProviderRest } = params.existingProvider ?? {};
	const normalizedApiKey = typeof existingApiKey === "string" ? existingApiKey.trim() : void 0;
	return {
		...existingProviderRest,
		baseUrl: params.baseUrl,
		api: params.api,
		...normalizedApiKey ? { apiKey: normalizedApiKey } : {},
		models: params.mergedModels.length > 0 ? params.mergedModels : params.fallbackModels
	};
}
//#endregion
//#region src/commands/onboard-auth.config-gateways.ts
function applyVercelAiGatewayProviderConfig(cfg) {
	const models = { ...cfg.agents?.defaults?.models };
	models[VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF] = {
		...models[VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF],
		alias: models["vercel-ai-gateway/anthropic/claude-opus-4.6"]?.alias ?? "Vercel AI Gateway"
	};
	return {
		...cfg,
		agents: {
			...cfg.agents,
			defaults: {
				...cfg.agents?.defaults,
				models
			}
		}
	};
}
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
function applyVercelAiGatewayConfig(cfg) {
	return applyAgentDefaultModelPrimary(applyVercelAiGatewayProviderConfig(cfg), VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF);
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
//#region src/commands/onboard-auth.config-core.ts
function applyZaiProviderConfig(cfg, params) {
	const modelRef = `zai/${params?.modelId?.trim() || "glm-5"}`;
	const models = { ...cfg.agents?.defaults?.models };
	models[modelRef] = {
		...models[modelRef],
		alias: models[modelRef]?.alias ?? "GLM"
	};
	const providers = { ...cfg.models?.providers };
	const existingProvider = providers.zai;
	const existingModels = Array.isArray(existingProvider?.models) ? existingProvider.models : [];
	const defaultModels = [
		buildZaiModelDefinition({ id: "glm-5" }),
		buildZaiModelDefinition({ id: "glm-4.7" }),
		buildZaiModelDefinition({ id: "glm-4.7-flash" }),
		buildZaiModelDefinition({ id: "glm-4.7-flashx" })
	];
	const mergedModels = [...existingModels];
	const seen = new Set(existingModels.map((m) => m.id));
	for (const model of defaultModels) if (!seen.has(model.id)) {
		mergedModels.push(model);
		seen.add(model.id);
	}
	const { apiKey: existingApiKey, ...existingProviderRest } = existingProvider ?? {};
	const normalizedApiKey = (typeof existingApiKey === "string" ? existingApiKey : void 0)?.trim();
	const baseUrl = params?.endpoint ? resolveZaiBaseUrl(params.endpoint) : (typeof existingProvider?.baseUrl === "string" ? existingProvider.baseUrl : "") || resolveZaiBaseUrl();
	providers.zai = {
		...existingProviderRest,
		baseUrl,
		api: "openai-completions",
		...normalizedApiKey ? { apiKey: normalizedApiKey } : {},
		models: mergedModels.length > 0 ? mergedModels : defaultModels
	};
	return applyOnboardAuthAgentModelsAndProviders(cfg, {
		agentModels: models,
		providers
	});
}
function applyZaiConfig(cfg, params) {
	const modelId = params?.modelId?.trim() || "glm-5";
	const modelRef = modelId === "glm-5" ? ZAI_DEFAULT_MODEL_REF : `zai/${modelId}`;
	return applyAgentDefaultModelPrimary(applyZaiProviderConfig(cfg, params), modelRef);
}
function applyOpenrouterProviderConfig(cfg) {
	const models = { ...cfg.agents?.defaults?.models };
	models[OPENROUTER_DEFAULT_MODEL_REF] = {
		...models[OPENROUTER_DEFAULT_MODEL_REF],
		alias: models["openrouter/auto"]?.alias ?? "OpenRouter"
	};
	return {
		...cfg,
		agents: {
			...cfg.agents,
			defaults: {
				...cfg.agents?.defaults,
				models
			}
		}
	};
}
function applyOpenrouterConfig(cfg) {
	return applyAgentDefaultModelPrimary(applyOpenrouterProviderConfig(cfg), OPENROUTER_DEFAULT_MODEL_REF);
}
function applyMoonshotProviderConfig(cfg) {
	return applyMoonshotProviderConfigWithBaseUrl(cfg, MOONSHOT_BASE_URL);
}
function applyMoonshotProviderConfigCn(cfg) {
	return applyMoonshotProviderConfigWithBaseUrl(cfg, MOONSHOT_CN_BASE_URL);
}
function applyMoonshotProviderConfigWithBaseUrl(cfg, baseUrl) {
	const models = { ...cfg.agents?.defaults?.models };
	models[MOONSHOT_DEFAULT_MODEL_REF] = {
		...models[MOONSHOT_DEFAULT_MODEL_REF],
		alias: models[MOONSHOT_DEFAULT_MODEL_REF]?.alias ?? "Kimi"
	};
	return applyProviderConfigWithDefaultModel(cfg, {
		agentModels: models,
		providerId: "moonshot",
		api: "openai-completions",
		baseUrl,
		defaultModel: buildMoonshotModelDefinition(),
		defaultModelId: MOONSHOT_DEFAULT_MODEL_ID
	});
}
function applyMoonshotConfig(cfg) {
	return applyAgentDefaultModelPrimary(applyMoonshotProviderConfig(cfg), MOONSHOT_DEFAULT_MODEL_REF);
}
function applyMoonshotConfigCn(cfg) {
	return applyAgentDefaultModelPrimary(applyMoonshotProviderConfigCn(cfg), MOONSHOT_DEFAULT_MODEL_REF);
}
function applyKimiCodeProviderConfig(cfg) {
	const models = { ...cfg.agents?.defaults?.models };
	models[KIMI_CODING_MODEL_REF] = {
		...models[KIMI_CODING_MODEL_REF],
		alias: models[KIMI_CODING_MODEL_REF]?.alias ?? "Kimi for Coding"
	};
	const defaultModel = buildKimiCodingProvider().models[0];
	return applyProviderConfigWithDefaultModel(cfg, {
		agentModels: models,
		providerId: "kimi-coding",
		api: "anthropic-messages",
		baseUrl: "https://api.kimi.com/coding/",
		defaultModel,
		defaultModelId: KIMI_CODING_MODEL_ID
	});
}
function applyKimiCodeConfig(cfg) {
	return applyAgentDefaultModelPrimary(applyKimiCodeProviderConfig(cfg), KIMI_CODING_MODEL_REF);
}
function applySyntheticProviderConfig(cfg) {
	const models = { ...cfg.agents?.defaults?.models };
	models[SYNTHETIC_DEFAULT_MODEL_REF] = {
		...models[SYNTHETIC_DEFAULT_MODEL_REF],
		alias: models[SYNTHETIC_DEFAULT_MODEL_REF]?.alias ?? "MiniMax M2.5"
	};
	const providers = { ...cfg.models?.providers };
	const existingProvider = providers.synthetic;
	const existingModels = Array.isArray(existingProvider?.models) ? existingProvider.models : [];
	const syntheticModels = SYNTHETIC_MODEL_CATALOG.map(buildSyntheticModelDefinition);
	const mergedModels = [...existingModels, ...syntheticModels.filter((model) => !existingModels.some((existing) => existing.id === model.id))];
	const { apiKey: existingApiKey, ...existingProviderRest } = existingProvider ?? {};
	const normalizedApiKey = (typeof existingApiKey === "string" ? existingApiKey : void 0)?.trim();
	providers.synthetic = {
		...existingProviderRest,
		baseUrl: SYNTHETIC_BASE_URL,
		api: "anthropic-messages",
		...normalizedApiKey ? { apiKey: normalizedApiKey } : {},
		models: mergedModels.length > 0 ? mergedModels : syntheticModels
	};
	return applyOnboardAuthAgentModelsAndProviders(cfg, {
		agentModels: models,
		providers
	});
}
function applySyntheticConfig(cfg) {
	return applyAgentDefaultModelPrimary(applySyntheticProviderConfig(cfg), SYNTHETIC_DEFAULT_MODEL_REF);
}
function applyXiaomiProviderConfig(cfg) {
	const models = { ...cfg.agents?.defaults?.models };
	models[XIAOMI_DEFAULT_MODEL_REF] = {
		...models[XIAOMI_DEFAULT_MODEL_REF],
		alias: models["xiaomi/mimo-v2-flash"]?.alias ?? "Xiaomi"
	};
	const defaultProvider = buildXiaomiProvider();
	return applyProviderConfigWithDefaultModels(cfg, {
		agentModels: models,
		providerId: "xiaomi",
		api: defaultProvider.api ?? "openai-completions",
		baseUrl: defaultProvider.baseUrl,
		defaultModels: defaultProvider.models ?? [],
		defaultModelId: XIAOMI_DEFAULT_MODEL_ID
	});
}
function applyXiaomiConfig(cfg) {
	return applyAgentDefaultModelPrimary(applyXiaomiProviderConfig(cfg), XIAOMI_DEFAULT_MODEL_REF);
}
/**
* Apply Venice provider configuration without changing the default model.
* Registers Venice models and sets up the provider, but preserves existing model selection.
*/
function applyVeniceProviderConfig(cfg) {
	const models = { ...cfg.agents?.defaults?.models };
	models[VENICE_DEFAULT_MODEL_REF] = {
		...models[VENICE_DEFAULT_MODEL_REF],
		alias: models[VENICE_DEFAULT_MODEL_REF]?.alias ?? "Kimi K2.5"
	};
	return applyProviderConfigWithModelCatalog(cfg, {
		agentModels: models,
		providerId: "venice",
		api: "openai-completions",
		baseUrl: VENICE_BASE_URL,
		catalogModels: VENICE_MODEL_CATALOG.map(buildVeniceModelDefinition)
	});
}
/**
* Apply Venice provider configuration AND set Venice as the default model.
* Use this when Venice is the primary provider choice during onboarding.
*/
function applyVeniceConfig(cfg) {
	return applyAgentDefaultModelPrimary(applyVeniceProviderConfig(cfg), VENICE_DEFAULT_MODEL_REF);
}
/**
* Apply Together provider configuration without changing the default model.
* Registers Together models and sets up the provider, but preserves existing model selection.
*/
function applyTogetherProviderConfig(cfg) {
	const models = { ...cfg.agents?.defaults?.models };
	models[TOGETHER_DEFAULT_MODEL_REF] = {
		...models[TOGETHER_DEFAULT_MODEL_REF],
		alias: models["together/moonshotai/Kimi-K2.5"]?.alias ?? "Together AI"
	};
	return applyProviderConfigWithModelCatalog(cfg, {
		agentModels: models,
		providerId: "together",
		api: "openai-completions",
		baseUrl: TOGETHER_BASE_URL,
		catalogModels: TOGETHER_MODEL_CATALOG.map(buildTogetherModelDefinition)
	});
}
/**
* Apply Together provider configuration AND set Together as the default model.
* Use this when Together is the primary provider choice during onboarding.
*/
function applyTogetherConfig(cfg) {
	return applyAgentDefaultModelPrimary(applyTogetherProviderConfig(cfg), TOGETHER_DEFAULT_MODEL_REF);
}
/**
* Apply Hugging Face (Inference Providers) provider configuration without changing the default model.
*/
function applyHuggingfaceProviderConfig(cfg) {
	const models = { ...cfg.agents?.defaults?.models };
	models[HUGGINGFACE_DEFAULT_MODEL_REF] = {
		...models[HUGGINGFACE_DEFAULT_MODEL_REF],
		alias: models["huggingface/deepseek-ai/DeepSeek-R1"]?.alias ?? "Hugging Face"
	};
	return applyProviderConfigWithModelCatalog(cfg, {
		agentModels: models,
		providerId: "huggingface",
		api: "openai-completions",
		baseUrl: HUGGINGFACE_BASE_URL,
		catalogModels: HUGGINGFACE_MODEL_CATALOG.map(buildHuggingfaceModelDefinition)
	});
}
/**
* Apply Hugging Face provider configuration AND set Hugging Face as the default model.
*/
function applyHuggingfaceConfig(cfg) {
	return applyAgentDefaultModelPrimary(applyHuggingfaceProviderConfig(cfg), HUGGINGFACE_DEFAULT_MODEL_REF);
}
function applyXaiProviderConfig(cfg) {
	const models = { ...cfg.agents?.defaults?.models };
	models[XAI_DEFAULT_MODEL_REF] = {
		...models[XAI_DEFAULT_MODEL_REF],
		alias: models[XAI_DEFAULT_MODEL_REF]?.alias ?? "Grok"
	};
	return applyProviderConfigWithDefaultModel(cfg, {
		agentModels: models,
		providerId: "xai",
		api: "openai-completions",
		baseUrl: XAI_BASE_URL,
		defaultModel: buildXaiModelDefinition(),
		defaultModelId: XAI_DEFAULT_MODEL_ID
	});
}
function applyXaiConfig(cfg) {
	return applyAgentDefaultModelPrimary(applyXaiProviderConfig(cfg), XAI_DEFAULT_MODEL_REF);
}
function applyMistralProviderConfig(cfg) {
	const models = { ...cfg.agents?.defaults?.models };
	models[MISTRAL_DEFAULT_MODEL_REF] = {
		...models[MISTRAL_DEFAULT_MODEL_REF],
		alias: models[MISTRAL_DEFAULT_MODEL_REF]?.alias ?? "Mistral"
	};
	return applyProviderConfigWithDefaultModel(cfg, {
		agentModels: models,
		providerId: "mistral",
		api: "openai-completions",
		baseUrl: MISTRAL_BASE_URL,
		defaultModel: buildMistralModelDefinition(),
		defaultModelId: MISTRAL_DEFAULT_MODEL_ID
	});
}
function applyMistralConfig(cfg) {
	return applyAgentDefaultModelPrimary(applyMistralProviderConfig(cfg), MISTRAL_DEFAULT_MODEL_REF);
}
/**
* Apply Kilo Gateway provider configuration without changing the default model.
* Registers Kilo Gateway and sets up the provider, but preserves existing model selection.
*/
function applyKilocodeProviderConfig(cfg) {
	const models = { ...cfg.agents?.defaults?.models };
	models[KILOCODE_DEFAULT_MODEL_REF] = {
		...models[KILOCODE_DEFAULT_MODEL_REF],
		alias: models[KILOCODE_DEFAULT_MODEL_REF]?.alias ?? "Kilo Gateway"
	};
	return applyProviderConfigWithModelCatalog(cfg, {
		agentModels: models,
		providerId: "kilocode",
		api: "openai-completions",
		baseUrl: KILOCODE_BASE_URL,
		catalogModels: buildKilocodeProvider().models ?? []
	});
}
/**
* Apply Kilo Gateway provider configuration AND set Kilo Gateway as the default model.
* Use this when Kilo Gateway is the primary provider choice during onboarding.
*/
function applyKilocodeConfig(cfg) {
	return applyAgentDefaultModelPrimary(applyKilocodeProviderConfig(cfg), KILOCODE_DEFAULT_MODEL_REF);
}
function applyAuthProfileConfig(cfg, params) {
	const normalizedProvider = params.provider.toLowerCase();
	const profiles = {
		...cfg.auth?.profiles,
		[params.profileId]: {
			provider: params.provider,
			mode: params.mode,
			...params.email ? { email: params.email } : {}
		}
	};
	const configuredProviderProfiles = Object.entries(cfg.auth?.profiles ?? {}).filter(([, profile]) => profile.provider.toLowerCase() === normalizedProvider).map(([profileId, profile]) => ({
		profileId,
		mode: profile.mode
	}));
	const existingProviderOrder = cfg.auth?.order?.[params.provider];
	const preferProfileFirst = params.preferProfileFirst ?? true;
	const reorderedProviderOrder = existingProviderOrder && preferProfileFirst ? [params.profileId, ...existingProviderOrder.filter((profileId) => profileId !== params.profileId)] : existingProviderOrder;
	const hasMixedConfiguredModes = configuredProviderProfiles.some(({ profileId, mode }) => profileId !== params.profileId && mode !== params.mode);
	const derivedProviderOrder = existingProviderOrder === void 0 && preferProfileFirst && hasMixedConfiguredModes ? [params.profileId, ...configuredProviderProfiles.map(({ profileId }) => profileId).filter((profileId) => profileId !== params.profileId)] : void 0;
	const order = existingProviderOrder !== void 0 ? {
		...cfg.auth?.order,
		[params.provider]: reorderedProviderOrder?.includes(params.profileId) ? reorderedProviderOrder : [...reorderedProviderOrder ?? [], params.profileId]
	} : derivedProviderOrder ? {
		...cfg.auth?.order,
		[params.provider]: derivedProviderOrder
	} : cfg.auth?.order;
	return {
		...cfg,
		auth: {
			...cfg.auth,
			profiles,
			...order ? { order } : {}
		}
	};
}
function applyQianfanProviderConfig(cfg) {
	const models = { ...cfg.agents?.defaults?.models };
	models[QIANFAN_DEFAULT_MODEL_REF] = {
		...models[QIANFAN_DEFAULT_MODEL_REF],
		alias: models[QIANFAN_DEFAULT_MODEL_REF]?.alias ?? "QIANFAN"
	};
	const defaultProvider = buildQianfanProvider();
	const existingProvider = cfg.models?.providers?.qianfan;
	const resolvedBaseUrl = (typeof existingProvider?.baseUrl === "string" ? existingProvider.baseUrl.trim() : "") || "https://qianfan.baidubce.com/v2";
	return applyProviderConfigWithDefaultModels(cfg, {
		agentModels: models,
		providerId: "qianfan",
		api: typeof existingProvider?.api === "string" ? existingProvider.api : "openai-completions",
		baseUrl: resolvedBaseUrl,
		defaultModels: defaultProvider.models ?? [],
		defaultModelId: QIANFAN_DEFAULT_MODEL_ID
	});
}
function applyQianfanConfig(cfg) {
	return applyAgentDefaultModelPrimary(applyQianfanProviderConfig(cfg), QIANFAN_DEFAULT_MODEL_REF);
}
function applyModelStudioProviderConfigWithBaseUrl(cfg, baseUrl) {
	const models = { ...cfg.agents?.defaults?.models };
	for (const modelId of [
		"qwen3.5-plus",
		"qwen3-max-2026-01-23",
		"qwen3-coder-next",
		"qwen3-coder-plus",
		"MiniMax-M2.5",
		"glm-5",
		"glm-4.7",
		"kimi-k2.5"
	]) {
		const modelRef = `modelstudio/${modelId}`;
		if (!models[modelRef]) models[modelRef] = {};
	}
	models[MODELSTUDIO_DEFAULT_MODEL_REF] = {
		...models[MODELSTUDIO_DEFAULT_MODEL_REF],
		alias: models[MODELSTUDIO_DEFAULT_MODEL_REF]?.alias ?? "Qwen"
	};
	const providers = { ...cfg.models?.providers };
	const existingProvider = providers.modelstudio;
	const existingModels = Array.isArray(existingProvider?.models) ? existingProvider.models : [];
	const defaultModels = [
		buildModelStudioModelDefinition({ id: "qwen3.5-plus" }),
		buildModelStudioModelDefinition({ id: "qwen3-max-2026-01-23" }),
		buildModelStudioModelDefinition({ id: "qwen3-coder-next" }),
		buildModelStudioModelDefinition({ id: "qwen3-coder-plus" }),
		buildModelStudioModelDefinition({ id: "MiniMax-M2.5" }),
		buildModelStudioModelDefinition({ id: "glm-5" }),
		buildModelStudioModelDefinition({ id: "glm-4.7" }),
		buildModelStudioModelDefinition({ id: "kimi-k2.5" })
	];
	const mergedModels = [...existingModels];
	const seen = new Set(existingModels.map((m) => m.id));
	for (const model of defaultModels) if (!seen.has(model.id)) {
		mergedModels.push(model);
		seen.add(model.id);
	}
	const { apiKey: existingApiKey, ...existingProviderRest } = existingProvider ?? {};
	const normalizedApiKey = (typeof existingApiKey === "string" ? existingApiKey : void 0)?.trim();
	providers.modelstudio = {
		...existingProviderRest,
		baseUrl,
		api: "openai-completions",
		...normalizedApiKey ? { apiKey: normalizedApiKey } : {},
		models: mergedModels.length > 0 ? mergedModels : defaultModels
	};
	return applyOnboardAuthAgentModelsAndProviders(cfg, {
		agentModels: models,
		providers
	});
}
function applyModelStudioProviderConfig(cfg) {
	return applyModelStudioProviderConfigWithBaseUrl(cfg, MODELSTUDIO_GLOBAL_BASE_URL);
}
function applyModelStudioProviderConfigCn(cfg) {
	return applyModelStudioProviderConfigWithBaseUrl(cfg, MODELSTUDIO_CN_BASE_URL);
}
function applyModelStudioConfig(cfg) {
	return applyAgentDefaultModelPrimary(applyModelStudioProviderConfig(cfg), MODELSTUDIO_DEFAULT_MODEL_REF);
}
function applyModelStudioConfigCn(cfg) {
	return applyAgentDefaultModelPrimary(applyModelStudioProviderConfigCn(cfg), MODELSTUDIO_DEFAULT_MODEL_REF);
}
//#endregion
//#region src/commands/onboard-auth.config-minimax.ts
function applyMinimaxApiProviderConfigWithBaseUrl(cfg, params) {
	const providers = { ...cfg.models?.providers };
	const existingProvider = providers[params.providerId];
	const existingModels = existingProvider?.models ?? [];
	const apiModel = buildMinimaxApiModelDefinition(params.modelId);
	const mergedModels = existingModels.some((model) => model.id === params.modelId) ? existingModels : [...existingModels, apiModel];
	const { apiKey: existingApiKey, ...existingProviderRest } = existingProvider ?? {
		baseUrl: params.baseUrl,
		models: []
	};
	const resolvedApiKey = typeof existingApiKey === "string" ? existingApiKey : void 0;
	const normalizedApiKey = resolvedApiKey?.trim() === "minimax" ? "" : resolvedApiKey;
	providers[params.providerId] = {
		...existingProviderRest,
		baseUrl: params.baseUrl,
		api: "anthropic-messages",
		authHeader: true,
		...normalizedApiKey?.trim() ? { apiKey: normalizedApiKey } : {},
		models: mergedModels.length > 0 ? mergedModels : [apiModel]
	};
	const models = { ...cfg.agents?.defaults?.models };
	const modelRef = `${params.providerId}/${params.modelId}`;
	models[modelRef] = {
		...models[modelRef],
		alias: "Minimax"
	};
	return applyOnboardAuthAgentModelsAndProviders(cfg, {
		agentModels: models,
		providers
	});
}
function applyMinimaxApiConfigWithBaseUrl(cfg, params) {
	return applyAgentDefaultModelPrimary(applyMinimaxApiProviderConfigWithBaseUrl(cfg, params), `${params.providerId}/${params.modelId}`);
}
function applyMinimaxApiProviderConfig(cfg, modelId = "MiniMax-M2.5") {
	return applyMinimaxApiProviderConfigWithBaseUrl(cfg, {
		providerId: "minimax",
		modelId,
		baseUrl: MINIMAX_API_BASE_URL
	});
}
function applyMinimaxApiConfig(cfg, modelId = "MiniMax-M2.5") {
	return applyMinimaxApiConfigWithBaseUrl(cfg, {
		providerId: "minimax",
		modelId,
		baseUrl: MINIMAX_API_BASE_URL
	});
}
function applyMinimaxApiProviderConfigCn(cfg, modelId = "MiniMax-M2.5") {
	return applyMinimaxApiProviderConfigWithBaseUrl(cfg, {
		providerId: "minimax",
		modelId,
		baseUrl: MINIMAX_CN_API_BASE_URL
	});
}
function applyMinimaxApiConfigCn(cfg, modelId = "MiniMax-M2.5") {
	return applyMinimaxApiConfigWithBaseUrl(cfg, {
		providerId: "minimax",
		modelId,
		baseUrl: MINIMAX_CN_API_BASE_URL
	});
}
createSubsystemLogger("opencode-zen-models");
const OPENCODE_ZEN_DEFAULT_MODEL_REF = `opencode/claude-opus-4-6`;
//#endregion
//#region src/commands/onboard-auth.config-opencode.ts
function applyOpencodeZenProviderConfig(cfg) {
	const models = { ...cfg.agents?.defaults?.models };
	models[OPENCODE_ZEN_DEFAULT_MODEL_REF] = {
		...models[OPENCODE_ZEN_DEFAULT_MODEL_REF],
		alias: models[OPENCODE_ZEN_DEFAULT_MODEL_REF]?.alias ?? "Opus"
	};
	return {
		...cfg,
		agents: {
			...cfg.agents,
			defaults: {
				...cfg.agents?.defaults,
				models
			}
		}
	};
}
function applyOpencodeZenConfig(cfg) {
	return applyAgentDefaultModelPrimary(applyOpencodeZenProviderConfig(cfg), OPENCODE_ZEN_DEFAULT_MODEL_REF);
}
//#endregion
//#region src/commands/model-default.ts
function resolvePrimaryModel$1(model) {
	if (typeof model === "string") return model;
	if (model && typeof model === "object" && typeof model.primary === "string") return model.primary;
}
function applyAgentDefaultPrimaryModel(params) {
	const current = resolvePrimaryModel$1(params.cfg.agents?.defaults?.model)?.trim();
	if ((current && params.legacyModels?.has(current) ? params.model : current) === params.model) return {
		next: params.cfg,
		changed: false
	};
	return {
		next: {
			...params.cfg,
			agents: {
				...params.cfg.agents,
				defaults: {
					...params.cfg.agents?.defaults,
					model: params.cfg.agents?.defaults?.model && typeof params.cfg.agents.defaults.model === "object" ? {
						...params.cfg.agents.defaults.model,
						primary: params.model
					} : { primary: params.model }
				}
			}
		},
		changed: true
	};
}
//#endregion
//#region src/commands/opencode-go-model-default.ts
const OPENCODE_GO_DEFAULT_MODEL_REF = "opencode-go/kimi-k2.5";
//#endregion
//#region src/commands/onboard-auth.config-opencode-go.ts
const OPENCODE_GO_ALIAS_DEFAULTS = {
	"opencode-go/kimi-k2.5": "Kimi",
	"opencode-go/glm-5": "GLM",
	"opencode-go/minimax-m2.5": "MiniMax"
};
function applyOpencodeGoProviderConfig(cfg) {
	const models = { ...cfg.agents?.defaults?.models };
	for (const [modelRef, alias] of Object.entries(OPENCODE_GO_ALIAS_DEFAULTS)) models[modelRef] = {
		...models[modelRef],
		alias: models[modelRef]?.alias ?? alias
	};
	return {
		...cfg,
		agents: {
			...cfg.agents,
			defaults: {
				...cfg.agents?.defaults,
				models
			}
		}
	};
}
function applyOpencodeGoConfig(cfg) {
	return applyAgentDefaultModelPrimary(applyOpencodeGoProviderConfig(cfg), OPENCODE_GO_DEFAULT_MODEL_REF);
}
//#endregion
//#region src/commands/oauth-env.ts
function isRemoteEnvironment() {
	if (process.env.SSH_CLIENT || process.env.SSH_TTY || process.env.SSH_CONNECTION) return true;
	if (process.env.REMOTE_CONTAINERS || process.env.CODESPACES) return true;
	if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY && !isWSLEnv()) return true;
	return false;
}
//#endregion
//#region src/commands/oauth-flow.ts
const validateRequiredInput = (value) => value.trim().length > 0 ? void 0 : "Required";
function createVpsAwareOAuthHandlers(params) {
	const manualPromptMessage = params.manualPromptMessage ?? "Paste the redirect URL";
	let manualCodePromise;
	return {
		onAuth: async ({ url }) => {
			if (params.isRemote) {
				params.spin.stop("OAuth URL ready");
				params.runtime.log(`\nOpen this URL in your LOCAL browser:\n\n${url}\n`);
				manualCodePromise = params.prompter.text({
					message: manualPromptMessage,
					validate: validateRequiredInput
				}).then((value) => String(value));
				return;
			}
			params.spin.update(params.localBrowserMessage);
			await params.openUrl(url);
			params.runtime.log(`Open: ${url}`);
		},
		onPrompt: async (prompt) => {
			if (manualCodePromise) return manualCodePromise;
			const code = await params.prompter.text({
				message: prompt.message,
				placeholder: prompt.placeholder,
				validate: validateRequiredInput
			});
			return String(code);
		}
	};
}
//#endregion
//#region src/commands/openai-codex-model-default.ts
const OPENAI_CODEX_DEFAULT_MODEL = "openai-codex/gpt-5.4";
function shouldSetOpenAICodexModel(model) {
	const trimmed = model?.trim();
	if (!trimmed) return true;
	const normalized = trimmed.toLowerCase();
	if (normalized.startsWith("openai-codex/")) return false;
	if (normalized.startsWith("openai/")) return true;
	return normalized === "gpt" || normalized === "gpt-mini";
}
function resolvePrimaryModel(model) {
	if (typeof model === "string") return model;
	if (model && typeof model === "object" && typeof model.primary === "string") return model.primary;
}
function applyOpenAICodexModelDefault(cfg) {
	if (!shouldSetOpenAICodexModel(resolvePrimaryModel(cfg.agents?.defaults?.model))) return {
		next: cfg,
		changed: false
	};
	return {
		next: {
			...cfg,
			agents: {
				...cfg.agents,
				defaults: {
					...cfg.agents?.defaults,
					model: cfg.agents?.defaults?.model && typeof cfg.agents.defaults.model === "object" ? {
						...cfg.agents.defaults.model,
						primary: OPENAI_CODEX_DEFAULT_MODEL
					} : { primary: OPENAI_CODEX_DEFAULT_MODEL }
				}
			}
		},
		changed: true
	};
}
//#endregion
//#region src/commands/provider-auth-helpers.ts
function resolveProviderMatch(providers, rawProvider) {
	const raw = rawProvider?.trim();
	if (!raw) return null;
	const normalized = normalizeProviderId(raw);
	return providers.find((provider) => normalizeProviderId(provider.id) === normalized) ?? providers.find((provider) => provider.aliases?.some((alias) => normalizeProviderId(alias) === normalized) ?? false) ?? null;
}
function pickAuthMethod(provider, rawMethod) {
	const raw = rawMethod?.trim();
	if (!raw) return null;
	const normalized = raw.toLowerCase();
	return provider.auth.find((method) => method.id.toLowerCase() === normalized) ?? provider.auth.find((method) => method.label.toLowerCase() === normalized) ?? null;
}
function isPlainRecord(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function mergeConfigPatch(base, patch) {
	if (!isPlainRecord(base) || !isPlainRecord(patch)) return patch;
	const next = { ...base };
	for (const [key, value] of Object.entries(patch)) {
		const existing = next[key];
		if (isPlainRecord(existing) && isPlainRecord(value)) next[key] = mergeConfigPatch(existing, value);
		else next[key] = value;
	}
	return next;
}
function applyDefaultModel(cfg, model) {
	const models = { ...cfg.agents?.defaults?.models };
	models[model] = models[model] ?? {};
	const existingModel = cfg.agents?.defaults?.model;
	return {
		...cfg,
		agents: {
			...cfg.agents,
			defaults: {
				...cfg.agents?.defaults,
				models,
				model: {
					...existingModel && typeof existingModel === "object" && "fallbacks" in existingModel ? { fallbacks: existingModel.fallbacks } : void 0,
					primary: model
				}
			}
		}
	};
}
//#endregion
export { applyLitellmProviderConfig as $, loadValidConfigOrThrow as $t, applyModelStudioProviderConfig as A, setTogetherApiKey as At, applySyntheticConfig as B, MODELSTUDIO_DEFAULT_MODEL_REF as Bt, applyKilocodeProviderConfig as C, setMoonshotApiKey as Ct, applyMistralProviderConfig as D, setOpenrouterApiKey as Dt, applyMistralConfig as E, setOpencodeZenApiKey as Et, applyMoonshotProviderConfigCn as F, setXiaomiApiKey as Ft, applyVeniceProviderConfig as G, ZAI_CODING_CN_BASE_URL as Gt, applyTogetherConfig as H, QIANFAN_DEFAULT_MODEL_REF as Ht, applyOpenrouterConfig as I, setZaiApiKey as It, applyXiaomiConfig as J, applyDefaultModelPrimaryUpdate as Jt, applyXaiConfig as K, ZAI_CODING_GLOBAL_BASE_URL as Kt, applyOpenrouterProviderConfig as L, writeOAuthCredentials as Lt, applyMoonshotConfig as M, setVercelAiGatewayApiKey as Mt, applyMoonshotConfigCn as N, setVolcengineApiKey as Nt, applyModelStudioConfig as O, setQianfanApiKey as Ot, applyMoonshotProviderConfig as P, setXaiApiKey as Pt, applyLitellmConfig as Q, isLocalBaseUrl as Qt, applyQianfanConfig as R, KIMI_CODING_MODEL_REF as Rt, applyKilocodeConfig as S, setModelStudioApiKey as St, applyKimiCodeProviderConfig as T, setOpencodeGoApiKey as Tt, applyTogetherProviderConfig as U, XAI_DEFAULT_MODEL_REF as Ut, applySyntheticProviderConfig as V, MOONSHOT_DEFAULT_MODEL_REF as Vt, applyVeniceConfig as W, ZAI_CN_BASE_URL as Wt, applyZaiConfig as X, formatMs as Xt, applyXiaomiProviderConfig as Y, ensureFlagCompatibility as Yt, applyZaiProviderConfig as Z, formatTokenK as Zt, applyMinimaxApiProviderConfig as _, setKilocodeApiKey as _t, OPENAI_CODEX_DEFAULT_MODEL as a, updateConfig as an, HUGGINGFACE_DEFAULT_MODEL_REF as at, applyHuggingfaceConfig as b, setMinimaxApiKey as bt, isRemoteEnvironment as c, TOGETHER_DEFAULT_MODEL_REF as ct, OPENCODE_GO_DEFAULT_MODEL_REF as d, ZAI_DEFAULT_MODEL_REF as dt, mergePrimaryFallbackConfig as en, applyCloudflareAiGatewayConfig as et, applyAgentDefaultPrimaryModel as f, setAnthropicApiKey as ft, applyMinimaxApiConfigCn as g, setHuggingfaceApiKey as gt, applyMinimaxApiConfig as h, setGeminiApiKey as ht, resolveProviderMatch as i, resolveModelTarget as in, applyAgentDefaultModelPrimary as it, applyModelStudioProviderConfigCn as j, setVeniceApiKey as jt, applyModelStudioConfigCn as k, setSyntheticApiKey as kt, applyOpencodeGoConfig as l, VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF as lt, applyOpencodeZenProviderConfig as m, setCloudflareAiGatewayConfig as mt, mergeConfigPatch as n, resolveKnownAgentId as nn, applyVercelAiGatewayConfig as nt, applyOpenAICodexModelDefault as o, upsertCanonicalModelConfigEntry as on, LITELLM_DEFAULT_MODEL_REF as ot, applyOpencodeZenConfig as p, setByteplusApiKey as pt, applyXaiProviderConfig as q, ZAI_GLOBAL_BASE_URL as qt, pickAuthMethod as r, resolveModelKeysFromEntries as rn, applyVercelAiGatewayProviderConfig as rt, createVpsAwareOAuthHandlers as s, OPENROUTER_DEFAULT_MODEL_REF as st, applyDefaultModel as t, normalizeAlias as tn, applyCloudflareAiGatewayProviderConfig as tt, applyOpencodeGoProviderConfig as u, XIAOMI_DEFAULT_MODEL_REF as ut, applyMinimaxApiProviderConfigCn as v, setKimiCodingApiKey as vt, applyKimiCodeConfig as w, setOpenaiApiKey as wt, applyHuggingfaceProviderConfig as x, setMistralApiKey as xt, applyAuthProfileConfig as y, setLitellmApiKey as yt, applyQianfanProviderConfig as z, MISTRAL_DEFAULT_MODEL_REF as zt };
