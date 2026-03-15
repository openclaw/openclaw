//#region src/acp/runtime/errors.ts
const ACP_ERROR_CODES = [
	"ACP_BACKEND_MISSING",
	"ACP_BACKEND_UNAVAILABLE",
	"ACP_BACKEND_UNSUPPORTED_CONTROL",
	"ACP_DISPATCH_DISABLED",
	"ACP_INVALID_RUNTIME_OPTION",
	"ACP_SESSION_INIT_FAILED",
	"ACP_TURN_FAILED"
];
var AcpRuntimeError = class extends Error {
	constructor(code, message, options) {
		super(message);
		this.name = "AcpRuntimeError";
		this.code = code;
		this.cause = options?.cause;
	}
};
function isAcpRuntimeError(value) {
	return value instanceof AcpRuntimeError;
}
function toAcpRuntimeError(params) {
	if (params.error instanceof AcpRuntimeError) {return params.error;}
	if (params.error instanceof Error) {return new AcpRuntimeError(params.fallbackCode, params.error.message, { cause: params.error });}
	return new AcpRuntimeError(params.fallbackCode, params.fallbackMessage, { cause: params.error });
}
async function withAcpRuntimeErrorBoundary(params) {
	try {
		return await params.run();
	} catch (error) {
		throw toAcpRuntimeError({
			error,
			fallbackCode: params.fallbackCode,
			fallbackMessage: params.fallbackMessage
		});
	}
}
//#endregion
//#region src/acp/runtime/registry.ts
const ACP_RUNTIME_REGISTRY_STATE_KEY = Symbol.for("openclaw.acpRuntimeRegistryState");
function createAcpRuntimeRegistryGlobalState() {
	return { backendsById: /* @__PURE__ */ new Map() };
}
function resolveAcpRuntimeRegistryGlobalState() {
	const runtimeGlobal = globalThis;
	if (!runtimeGlobal[ACP_RUNTIME_REGISTRY_STATE_KEY]) {runtimeGlobal[ACP_RUNTIME_REGISTRY_STATE_KEY] = createAcpRuntimeRegistryGlobalState();}
	return runtimeGlobal[ACP_RUNTIME_REGISTRY_STATE_KEY];
}
const ACP_BACKENDS_BY_ID = resolveAcpRuntimeRegistryGlobalState().backendsById;
function normalizeBackendId(id) {
	return id?.trim().toLowerCase() || "";
}
function isBackendHealthy(backend) {
	if (!backend.healthy) {return true;}
	try {
		return backend.healthy();
	} catch {
		return false;
	}
}
function registerAcpRuntimeBackend(backend) {
	const id = normalizeBackendId(backend.id);
	if (!id) {throw new Error("ACP runtime backend id is required");}
	if (!backend.runtime) {throw new Error(`ACP runtime backend "${id}" is missing runtime implementation`);}
	ACP_BACKENDS_BY_ID.set(id, {
		...backend,
		id
	});
}
function unregisterAcpRuntimeBackend(id) {
	const normalized = normalizeBackendId(id);
	if (!normalized) {return;}
	ACP_BACKENDS_BY_ID.delete(normalized);
}
function getAcpRuntimeBackend(id) {
	const normalized = normalizeBackendId(id);
	if (normalized) {return ACP_BACKENDS_BY_ID.get(normalized) ?? null;}
	if (ACP_BACKENDS_BY_ID.size === 0) {return null;}
	for (const backend of ACP_BACKENDS_BY_ID.values()) {if (isBackendHealthy(backend)) return backend;}
	return ACP_BACKENDS_BY_ID.values().next().value ?? null;
}
function requireAcpRuntimeBackend(id) {
	const normalized = normalizeBackendId(id);
	const backend = getAcpRuntimeBackend(normalized || void 0);
	if (!backend) {throw new AcpRuntimeError("ACP_BACKEND_MISSING", "ACP runtime backend is not configured. Install and enable the acpx runtime plugin.");}
	if (!isBackendHealthy(backend)) {throw new AcpRuntimeError("ACP_BACKEND_UNAVAILABLE", "ACP runtime backend is currently unavailable. Try again in a moment.");}
	if (normalized && backend.id !== normalized) {throw new AcpRuntimeError("ACP_BACKEND_MISSING", `ACP runtime backend "${normalized}" is not registered.`);}
	return backend;
}
//#endregion
//#region extensions/anthropic/openclaw.plugin.json
var openclaw_plugin_default$30 = {
	id: "anthropic",
	providers: ["anthropic"],
	providerAuthEnvVars: { "anthropic": ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"] },
	providerAuthChoices: [{
		"provider": "anthropic",
		"method": "setup-token",
		"choiceId": "token",
		"choiceLabel": "Anthropic token (paste setup-token)",
		"choiceHint": "Run `claude setup-token` elsewhere, then paste the token here",
		"groupId": "anthropic",
		"groupLabel": "Anthropic",
		"groupHint": "setup-token + API key"
	}, {
		"provider": "anthropic",
		"method": "api-key",
		"choiceId": "apiKey",
		"choiceLabel": "Anthropic API key",
		"groupId": "anthropic",
		"groupLabel": "Anthropic",
		"groupHint": "setup-token + API key",
		"optionKey": "anthropicApiKey",
		"cliFlag": "--anthropic-api-key",
		"cliOption": "--anthropic-api-key <key>",
		"cliDescription": "Anthropic API key"
	}],
	configSchema: {
		"type": "object",
		"additionalProperties": false,
		"properties": {}
	}
};
//#endregion
//#region extensions/byteplus/openclaw.plugin.json
var openclaw_plugin_default$29 = {
	id: "byteplus",
	providers: ["byteplus", "byteplus-plan"],
	providerAuthEnvVars: { "byteplus": ["BYTEPLUS_API_KEY"] },
	providerAuthChoices: [{
		"provider": "byteplus",
		"method": "api-key",
		"choiceId": "byteplus-api-key",
		"choiceLabel": "BytePlus API key",
		"groupId": "byteplus",
		"groupLabel": "BytePlus",
		"groupHint": "API key",
		"optionKey": "byteplusApiKey",
		"cliFlag": "--byteplus-api-key",
		"cliOption": "--byteplus-api-key <key>",
		"cliDescription": "BytePlus API key"
	}],
	configSchema: {
		"type": "object",
		"additionalProperties": false,
		"properties": {}
	}
};
//#endregion
//#region extensions/cloudflare-ai-gateway/openclaw.plugin.json
var openclaw_plugin_default$28 = {
	id: "cloudflare-ai-gateway",
	providers: ["cloudflare-ai-gateway"],
	providerAuthEnvVars: { "cloudflare-ai-gateway": ["CLOUDFLARE_AI_GATEWAY_API_KEY"] },
	providerAuthChoices: [{
		"provider": "cloudflare-ai-gateway",
		"method": "api-key",
		"choiceId": "cloudflare-ai-gateway-api-key",
		"choiceLabel": "Cloudflare AI Gateway",
		"choiceHint": "Account ID + Gateway ID + API key",
		"groupId": "cloudflare-ai-gateway",
		"groupLabel": "Cloudflare AI Gateway",
		"groupHint": "Account ID + Gateway ID + API key",
		"optionKey": "cloudflareAiGatewayApiKey",
		"cliFlag": "--cloudflare-ai-gateway-api-key",
		"cliOption": "--cloudflare-ai-gateway-api-key <key>",
		"cliDescription": "Cloudflare AI Gateway API key"
	}],
	configSchema: {
		"type": "object",
		"additionalProperties": false,
		"properties": {}
	}
};
//#endregion
//#region extensions/copilot-proxy/openclaw.plugin.json
var openclaw_plugin_default$27 = {
	id: "copilot-proxy",
	providers: ["copilot-proxy"],
	providerAuthChoices: [{
		"provider": "copilot-proxy",
		"method": "local",
		"choiceId": "copilot-proxy",
		"choiceLabel": "Copilot Proxy",
		"choiceHint": "Configure base URL + model ids",
		"groupId": "copilot",
		"groupLabel": "Copilot",
		"groupHint": "GitHub + local proxy"
	}],
	configSchema: {
		"type": "object",
		"additionalProperties": false,
		"properties": {}
	}
};
//#endregion
//#region extensions/github-copilot/openclaw.plugin.json
var openclaw_plugin_default$26 = {
	id: "github-copilot",
	providers: ["github-copilot"],
	providerAuthEnvVars: { "github-copilot": [
		"COPILOT_GITHUB_TOKEN",
		"GH_TOKEN",
		"GITHUB_TOKEN"
	] },
	providerAuthChoices: [{
		"provider": "github-copilot",
		"method": "device",
		"choiceId": "github-copilot",
		"choiceLabel": "GitHub Copilot",
		"choiceHint": "Device login with your GitHub account",
		"groupId": "copilot",
		"groupLabel": "Copilot",
		"groupHint": "GitHub + local proxy"
	}],
	configSchema: {
		"type": "object",
		"additionalProperties": false,
		"properties": {}
	}
};
//#endregion
//#region extensions/google/openclaw.plugin.json
var openclaw_plugin_default$25 = {
	id: "google",
	providers: ["google", "google-gemini-cli"],
	providerAuthEnvVars: { "google": ["GEMINI_API_KEY", "GOOGLE_API_KEY"] },
	providerAuthChoices: [{
		"provider": "google",
		"method": "api-key",
		"choiceId": "gemini-api-key",
		"choiceLabel": "Google Gemini API key",
		"groupId": "google",
		"groupLabel": "Google",
		"groupHint": "Gemini API key + OAuth",
		"optionKey": "geminiApiKey",
		"cliFlag": "--gemini-api-key",
		"cliOption": "--gemini-api-key <key>",
		"cliDescription": "Gemini API key"
	}, {
		"provider": "google-gemini-cli",
		"method": "oauth",
		"choiceId": "google-gemini-cli",
		"choiceLabel": "Gemini CLI OAuth",
		"choiceHint": "Google OAuth with project-aware token payload",
		"groupId": "google",
		"groupLabel": "Google",
		"groupHint": "Gemini API key + OAuth"
	}],
	configSchema: {
		"type": "object",
		"additionalProperties": false,
		"properties": {}
	}
};
//#endregion
//#region extensions/huggingface/openclaw.plugin.json
var openclaw_plugin_default$24 = {
	id: "huggingface",
	providers: ["huggingface"],
	providerAuthEnvVars: { "huggingface": ["HUGGINGFACE_HUB_TOKEN", "HF_TOKEN"] },
	providerAuthChoices: [{
		"provider": "huggingface",
		"method": "api-key",
		"choiceId": "huggingface-api-key",
		"choiceLabel": "Hugging Face API key",
		"choiceHint": "Inference API (HF token)",
		"groupId": "huggingface",
		"groupLabel": "Hugging Face",
		"groupHint": "Inference API (HF token)",
		"optionKey": "huggingfaceApiKey",
		"cliFlag": "--huggingface-api-key",
		"cliOption": "--huggingface-api-key <key>",
		"cliDescription": "Hugging Face API key (HF token)"
	}],
	configSchema: {
		"type": "object",
		"additionalProperties": false,
		"properties": {}
	}
};
//#endregion
//#region extensions/kilocode/openclaw.plugin.json
var openclaw_plugin_default$23 = {
	id: "kilocode",
	providers: ["kilocode"],
	providerAuthEnvVars: { "kilocode": ["KILOCODE_API_KEY"] },
	providerAuthChoices: [{
		"provider": "kilocode",
		"method": "api-key",
		"choiceId": "kilocode-api-key",
		"choiceLabel": "Kilo Gateway API key",
		"choiceHint": "API key (OpenRouter-compatible)",
		"groupId": "kilocode",
		"groupLabel": "Kilo Gateway",
		"groupHint": "API key (OpenRouter-compatible)",
		"optionKey": "kilocodeApiKey",
		"cliFlag": "--kilocode-api-key",
		"cliOption": "--kilocode-api-key <key>",
		"cliDescription": "Kilo Gateway API key"
	}],
	configSchema: {
		"type": "object",
		"additionalProperties": false,
		"properties": {}
	}
};
//#endregion
//#region extensions/kimi-coding/openclaw.plugin.json
var openclaw_plugin_default$22 = {
	id: "kimi-coding",
	providers: ["kimi-coding"],
	providerAuthEnvVars: { "kimi-coding": ["KIMI_API_KEY", "KIMICODE_API_KEY"] },
	providerAuthChoices: [{
		"provider": "kimi-coding",
		"method": "api-key",
		"choiceId": "kimi-code-api-key",
		"choiceLabel": "Kimi Code API key (subscription)",
		"groupId": "moonshot",
		"groupLabel": "Moonshot AI (Kimi K2.5)",
		"groupHint": "Kimi K2.5 + Kimi Coding",
		"optionKey": "kimiCodeApiKey",
		"cliFlag": "--kimi-code-api-key",
		"cliOption": "--kimi-code-api-key <key>",
		"cliDescription": "Kimi Coding API key"
	}],
	configSchema: {
		"type": "object",
		"additionalProperties": false,
		"properties": {}
	}
};
//#endregion
//#region extensions/minimax/openclaw.plugin.json
var openclaw_plugin_default$21 = {
	id: "minimax",
	providers: ["minimax", "minimax-portal"],
	providerAuthEnvVars: {
		"minimax": ["MINIMAX_API_KEY"],
		"minimax-portal": ["MINIMAX_OAUTH_TOKEN", "MINIMAX_API_KEY"]
	},
	providerAuthChoices: [
		{
			"provider": "minimax-portal",
			"method": "oauth",
			"choiceId": "minimax-global-oauth",
			"choiceLabel": "MiniMax OAuth (Global)",
			"choiceHint": "Global endpoint - api.minimax.io",
			"groupId": "minimax",
			"groupLabel": "MiniMax",
			"groupHint": "M2.5 (recommended)"
		},
		{
			"provider": "minimax",
			"method": "api-global",
			"choiceId": "minimax-global-api",
			"choiceLabel": "MiniMax API key (Global)",
			"choiceHint": "Global endpoint - api.minimax.io",
			"groupId": "minimax",
			"groupLabel": "MiniMax",
			"groupHint": "M2.5 (recommended)",
			"optionKey": "minimaxApiKey",
			"cliFlag": "--minimax-api-key",
			"cliOption": "--minimax-api-key <key>",
			"cliDescription": "MiniMax API key"
		},
		{
			"provider": "minimax-portal",
			"method": "oauth-cn",
			"choiceId": "minimax-cn-oauth",
			"choiceLabel": "MiniMax OAuth (CN)",
			"choiceHint": "CN endpoint - api.minimaxi.com",
			"groupId": "minimax",
			"groupLabel": "MiniMax",
			"groupHint": "M2.5 (recommended)"
		},
		{
			"provider": "minimax",
			"method": "api-cn",
			"choiceId": "minimax-cn-api",
			"choiceLabel": "MiniMax API key (CN)",
			"choiceHint": "CN endpoint - api.minimaxi.com",
			"groupId": "minimax",
			"groupLabel": "MiniMax",
			"groupHint": "M2.5 (recommended)",
			"optionKey": "minimaxApiKey",
			"cliFlag": "--minimax-api-key",
			"cliOption": "--minimax-api-key <key>",
			"cliDescription": "MiniMax API key"
		}
	],
	configSchema: {
		"type": "object",
		"additionalProperties": false,
		"properties": {}
	}
};
//#endregion
//#region extensions/mistral/openclaw.plugin.json
var openclaw_plugin_default$20 = {
	id: "mistral",
	providers: ["mistral"],
	providerAuthEnvVars: { "mistral": ["MISTRAL_API_KEY"] },
	providerAuthChoices: [{
		"provider": "mistral",
		"method": "api-key",
		"choiceId": "mistral-api-key",
		"choiceLabel": "Mistral API key",
		"groupId": "mistral",
		"groupLabel": "Mistral AI",
		"groupHint": "API key",
		"optionKey": "mistralApiKey",
		"cliFlag": "--mistral-api-key",
		"cliOption": "--mistral-api-key <key>",
		"cliDescription": "Mistral API key"
	}],
	configSchema: {
		"type": "object",
		"additionalProperties": false,
		"properties": {}
	}
};
//#endregion
//#region extensions/modelstudio/openclaw.plugin.json
var openclaw_plugin_default$19 = {
	id: "modelstudio",
	providers: ["modelstudio"],
	providerAuthEnvVars: { "modelstudio": ["MODELSTUDIO_API_KEY"] },
	providerAuthChoices: [{
		"provider": "modelstudio",
		"method": "api-key-cn",
		"choiceId": "modelstudio-api-key-cn",
		"choiceLabel": "Coding Plan API Key for China (subscription)",
		"choiceHint": "Endpoint: coding.dashscope.aliyuncs.com",
		"groupId": "modelstudio",
		"groupLabel": "Alibaba Cloud Model Studio",
		"groupHint": "Coding Plan API key (CN / Global)",
		"optionKey": "modelstudioApiKeyCn",
		"cliFlag": "--modelstudio-api-key-cn",
		"cliOption": "--modelstudio-api-key-cn <key>",
		"cliDescription": "Alibaba Cloud Model Studio Coding Plan API key (China)"
	}, {
		"provider": "modelstudio",
		"method": "api-key",
		"choiceId": "modelstudio-api-key",
		"choiceLabel": "Coding Plan API Key for Global/Intl (subscription)",
		"choiceHint": "Endpoint: coding-intl.dashscope.aliyuncs.com",
		"groupId": "modelstudio",
		"groupLabel": "Alibaba Cloud Model Studio",
		"groupHint": "Coding Plan API key (CN / Global)",
		"optionKey": "modelstudioApiKey",
		"cliFlag": "--modelstudio-api-key",
		"cliOption": "--modelstudio-api-key <key>",
		"cliDescription": "Alibaba Cloud Model Studio Coding Plan API key (Global/Intl)"
	}],
	configSchema: {
		"type": "object",
		"additionalProperties": false,
		"properties": {}
	}
};
//#endregion
//#region extensions/moonshot/openclaw.plugin.json
var openclaw_plugin_default$18 = {
	id: "moonshot",
	providers: ["moonshot"],
	providerAuthEnvVars: { "moonshot": ["MOONSHOT_API_KEY"] },
	providerAuthChoices: [{
		"provider": "moonshot",
		"method": "api-key",
		"choiceId": "moonshot-api-key",
		"choiceLabel": "Kimi API key (.ai)",
		"groupId": "moonshot",
		"groupLabel": "Moonshot AI (Kimi K2.5)",
		"groupHint": "Kimi K2.5 + Kimi Coding",
		"optionKey": "moonshotApiKey",
		"cliFlag": "--moonshot-api-key",
		"cliOption": "--moonshot-api-key <key>",
		"cliDescription": "Moonshot API key"
	}, {
		"provider": "moonshot",
		"method": "api-key-cn",
		"choiceId": "moonshot-api-key-cn",
		"choiceLabel": "Kimi API key (.cn)",
		"groupId": "moonshot",
		"groupLabel": "Moonshot AI (Kimi K2.5)",
		"groupHint": "Kimi K2.5 + Kimi Coding",
		"optionKey": "moonshotApiKey",
		"cliFlag": "--moonshot-api-key",
		"cliOption": "--moonshot-api-key <key>",
		"cliDescription": "Moonshot API key"
	}],
	configSchema: {
		"type": "object",
		"additionalProperties": false,
		"properties": {}
	}
};
//#endregion
//#region extensions/nvidia/openclaw.plugin.json
var openclaw_plugin_default$17 = {
	id: "nvidia",
	providers: ["nvidia"],
	providerAuthEnvVars: { "nvidia": ["NVIDIA_API_KEY"] },
	configSchema: {
		"type": "object",
		"additionalProperties": false,
		"properties": {}
	}
};
//#endregion
//#region extensions/ollama/openclaw.plugin.json
var openclaw_plugin_default$16 = {
	id: "ollama",
	providers: ["ollama"],
	providerAuthEnvVars: { "ollama": ["OLLAMA_API_KEY"] },
	providerAuthChoices: [{
		"provider": "ollama",
		"method": "local",
		"choiceId": "ollama",
		"choiceLabel": "Ollama",
		"choiceHint": "Cloud and local open models",
		"groupId": "ollama",
		"groupLabel": "Ollama",
		"groupHint": "Cloud and local open models"
	}],
	configSchema: {
		"type": "object",
		"additionalProperties": false,
		"properties": {}
	}
};
//#endregion
//#region extensions/openai/openclaw.plugin.json
var openclaw_plugin_default$15 = {
	id: "openai",
	providers: ["openai", "openai-codex"],
	providerAuthEnvVars: { "openai": ["OPENAI_API_KEY"] },
	providerAuthChoices: [{
		"provider": "openai-codex",
		"method": "oauth",
		"choiceId": "openai-codex",
		"choiceLabel": "OpenAI Codex (ChatGPT OAuth)",
		"choiceHint": "Browser sign-in",
		"groupId": "openai",
		"groupLabel": "OpenAI",
		"groupHint": "Codex OAuth + API key"
	}, {
		"provider": "openai",
		"method": "api-key",
		"choiceId": "openai-api-key",
		"choiceLabel": "OpenAI API key",
		"groupId": "openai",
		"groupLabel": "OpenAI",
		"groupHint": "Codex OAuth + API key",
		"optionKey": "openaiApiKey",
		"cliFlag": "--openai-api-key",
		"cliOption": "--openai-api-key <key>",
		"cliDescription": "OpenAI API key"
	}],
	configSchema: {
		"type": "object",
		"additionalProperties": false,
		"properties": {}
	}
};
//#endregion
//#region extensions/opencode-go/openclaw.plugin.json
var openclaw_plugin_default$14 = {
	id: "opencode-go",
	providers: ["opencode-go"],
	providerAuthEnvVars: { "opencode-go": ["OPENCODE_API_KEY", "OPENCODE_ZEN_API_KEY"] },
	providerAuthChoices: [{
		"provider": "opencode-go",
		"method": "api-key",
		"choiceId": "opencode-go",
		"choiceLabel": "OpenCode Go catalog",
		"groupId": "opencode",
		"groupLabel": "OpenCode",
		"groupHint": "Shared API key for Zen + Go catalogs",
		"optionKey": "opencodeGoApiKey",
		"cliFlag": "--opencode-go-api-key",
		"cliOption": "--opencode-go-api-key <key>",
		"cliDescription": "OpenCode API key (Go catalog)"
	}],
	configSchema: {
		"type": "object",
		"additionalProperties": false,
		"properties": {}
	}
};
//#endregion
//#region extensions/opencode/openclaw.plugin.json
var openclaw_plugin_default$13 = {
	id: "opencode",
	providers: ["opencode"],
	providerAuthEnvVars: { "opencode": ["OPENCODE_API_KEY", "OPENCODE_ZEN_API_KEY"] },
	providerAuthChoices: [{
		"provider": "opencode",
		"method": "api-key",
		"choiceId": "opencode-zen",
		"choiceLabel": "OpenCode Zen catalog",
		"groupId": "opencode",
		"groupLabel": "OpenCode",
		"groupHint": "Shared API key for Zen + Go catalogs",
		"optionKey": "opencodeZenApiKey",
		"cliFlag": "--opencode-zen-api-key",
		"cliOption": "--opencode-zen-api-key <key>",
		"cliDescription": "OpenCode API key (Zen catalog)"
	}],
	configSchema: {
		"type": "object",
		"additionalProperties": false,
		"properties": {}
	}
};
//#endregion
//#region extensions/openrouter/openclaw.plugin.json
var openclaw_plugin_default$12 = {
	id: "openrouter",
	providers: ["openrouter"],
	providerAuthEnvVars: { "openrouter": ["OPENROUTER_API_KEY"] },
	providerAuthChoices: [{
		"provider": "openrouter",
		"method": "api-key",
		"choiceId": "openrouter-api-key",
		"choiceLabel": "OpenRouter API key",
		"groupId": "openrouter",
		"groupLabel": "OpenRouter",
		"groupHint": "API key",
		"optionKey": "openrouterApiKey",
		"cliFlag": "--openrouter-api-key",
		"cliOption": "--openrouter-api-key <key>",
		"cliDescription": "OpenRouter API key"
	}],
	configSchema: {
		"type": "object",
		"additionalProperties": false,
		"properties": {}
	}
};
//#endregion
//#region extensions/qianfan/openclaw.plugin.json
var openclaw_plugin_default$11 = {
	id: "qianfan",
	providers: ["qianfan"],
	providerAuthEnvVars: { "qianfan": ["QIANFAN_API_KEY"] },
	providerAuthChoices: [{
		"provider": "qianfan",
		"method": "api-key",
		"choiceId": "qianfan-api-key",
		"choiceLabel": "Qianfan API key",
		"groupId": "qianfan",
		"groupLabel": "Qianfan",
		"groupHint": "API key",
		"optionKey": "qianfanApiKey",
		"cliFlag": "--qianfan-api-key",
		"cliOption": "--qianfan-api-key <key>",
		"cliDescription": "QIANFAN API key"
	}],
	configSchema: {
		"type": "object",
		"additionalProperties": false,
		"properties": {}
	}
};
//#endregion
//#region extensions/qwen-portal-auth/openclaw.plugin.json
var openclaw_plugin_default$10 = {
	id: "qwen-portal-auth",
	providers: ["qwen-portal"],
	providerAuthEnvVars: { "qwen-portal": ["QWEN_OAUTH_TOKEN", "QWEN_PORTAL_API_KEY"] },
	providerAuthChoices: [{
		"provider": "qwen-portal",
		"method": "device",
		"choiceId": "qwen-portal",
		"choiceLabel": "Qwen OAuth",
		"choiceHint": "Device code login",
		"groupId": "qwen",
		"groupLabel": "Qwen",
		"groupHint": "OAuth"
	}],
	configSchema: {
		"type": "object",
		"additionalProperties": false,
		"properties": {}
	}
};
//#endregion
//#region extensions/sglang/openclaw.plugin.json
var openclaw_plugin_default$9 = {
	id: "sglang",
	providers: ["sglang"],
	providerAuthEnvVars: { "sglang": ["SGLANG_API_KEY"] },
	providerAuthChoices: [{
		"provider": "sglang",
		"method": "custom",
		"choiceId": "sglang",
		"choiceLabel": "SGLang",
		"choiceHint": "Fast self-hosted OpenAI-compatible server",
		"groupId": "sglang",
		"groupLabel": "SGLang",
		"groupHint": "Fast self-hosted server"
	}],
	configSchema: {
		"type": "object",
		"additionalProperties": false,
		"properties": {}
	}
};
//#endregion
//#region extensions/synthetic/openclaw.plugin.json
var openclaw_plugin_default$8 = {
	id: "synthetic",
	providers: ["synthetic"],
	providerAuthEnvVars: { "synthetic": ["SYNTHETIC_API_KEY"] },
	providerAuthChoices: [{
		"provider": "synthetic",
		"method": "api-key",
		"choiceId": "synthetic-api-key",
		"choiceLabel": "Synthetic API key",
		"groupId": "synthetic",
		"groupLabel": "Synthetic",
		"groupHint": "Anthropic-compatible (multi-model)",
		"optionKey": "syntheticApiKey",
		"cliFlag": "--synthetic-api-key",
		"cliOption": "--synthetic-api-key <key>",
		"cliDescription": "Synthetic API key"
	}],
	configSchema: {
		"type": "object",
		"additionalProperties": false,
		"properties": {}
	}
};
//#endregion
//#region extensions/together/openclaw.plugin.json
var openclaw_plugin_default$7 = {
	id: "together",
	providers: ["together"],
	providerAuthEnvVars: { "together": ["TOGETHER_API_KEY"] },
	providerAuthChoices: [{
		"provider": "together",
		"method": "api-key",
		"choiceId": "together-api-key",
		"choiceLabel": "Together AI API key",
		"groupId": "together",
		"groupLabel": "Together AI",
		"groupHint": "API key",
		"optionKey": "togetherApiKey",
		"cliFlag": "--together-api-key",
		"cliOption": "--together-api-key <key>",
		"cliDescription": "Together AI API key"
	}],
	configSchema: {
		"type": "object",
		"additionalProperties": false,
		"properties": {}
	}
};
//#endregion
//#region extensions/venice/openclaw.plugin.json
var openclaw_plugin_default$6 = {
	id: "venice",
	providers: ["venice"],
	providerAuthEnvVars: { "venice": ["VENICE_API_KEY"] },
	providerAuthChoices: [{
		"provider": "venice",
		"method": "api-key",
		"choiceId": "venice-api-key",
		"choiceLabel": "Venice AI API key",
		"groupId": "venice",
		"groupLabel": "Venice AI",
		"groupHint": "Privacy-focused (uncensored models)",
		"optionKey": "veniceApiKey",
		"cliFlag": "--venice-api-key",
		"cliOption": "--venice-api-key <key>",
		"cliDescription": "Venice API key"
	}],
	configSchema: {
		"type": "object",
		"additionalProperties": false,
		"properties": {}
	}
};
//#endregion
//#region extensions/vercel-ai-gateway/openclaw.plugin.json
var openclaw_plugin_default$5 = {
	id: "vercel-ai-gateway",
	providers: ["vercel-ai-gateway"],
	providerAuthEnvVars: { "vercel-ai-gateway": ["AI_GATEWAY_API_KEY"] },
	providerAuthChoices: [{
		"provider": "vercel-ai-gateway",
		"method": "api-key",
		"choiceId": "ai-gateway-api-key",
		"choiceLabel": "Vercel AI Gateway API key",
		"groupId": "ai-gateway",
		"groupLabel": "Vercel AI Gateway",
		"groupHint": "API key",
		"optionKey": "aiGatewayApiKey",
		"cliFlag": "--ai-gateway-api-key",
		"cliOption": "--ai-gateway-api-key <key>",
		"cliDescription": "Vercel AI Gateway API key"
	}],
	configSchema: {
		"type": "object",
		"additionalProperties": false,
		"properties": {}
	}
};
//#endregion
//#region extensions/vllm/openclaw.plugin.json
var openclaw_plugin_default$4 = {
	id: "vllm",
	providers: ["vllm"],
	providerAuthEnvVars: { "vllm": ["VLLM_API_KEY"] },
	providerAuthChoices: [{
		"provider": "vllm",
		"method": "custom",
		"choiceId": "vllm",
		"choiceLabel": "vLLM",
		"choiceHint": "Local/self-hosted OpenAI-compatible server",
		"groupId": "vllm",
		"groupLabel": "vLLM",
		"groupHint": "Local/self-hosted OpenAI-compatible"
	}],
	configSchema: {
		"type": "object",
		"additionalProperties": false,
		"properties": {}
	}
};
//#endregion
//#region extensions/volcengine/openclaw.plugin.json
var openclaw_plugin_default$3 = {
	id: "volcengine",
	providers: ["volcengine", "volcengine-plan"],
	providerAuthEnvVars: { "volcengine": ["VOLCANO_ENGINE_API_KEY"] },
	providerAuthChoices: [{
		"provider": "volcengine",
		"method": "api-key",
		"choiceId": "volcengine-api-key",
		"choiceLabel": "Volcano Engine API key",
		"groupId": "volcengine",
		"groupLabel": "Volcano Engine",
		"groupHint": "API key",
		"optionKey": "volcengineApiKey",
		"cliFlag": "--volcengine-api-key",
		"cliOption": "--volcengine-api-key <key>",
		"cliDescription": "Volcano Engine API key"
	}],
	configSchema: {
		"type": "object",
		"additionalProperties": false,
		"properties": {}
	}
};
//#endregion
//#region extensions/xai/openclaw.plugin.json
var openclaw_plugin_default$2 = {
	id: "xai",
	providers: ["xai"],
	providerAuthEnvVars: { "xai": ["XAI_API_KEY"] },
	providerAuthChoices: [{
		"provider": "xai",
		"method": "api-key",
		"choiceId": "xai-api-key",
		"choiceLabel": "xAI API key",
		"groupId": "xai",
		"groupLabel": "xAI (Grok)",
		"groupHint": "API key",
		"optionKey": "xaiApiKey",
		"cliFlag": "--xai-api-key",
		"cliOption": "--xai-api-key <key>",
		"cliDescription": "xAI API key"
	}],
	configSchema: {
		"type": "object",
		"additionalProperties": false,
		"properties": {}
	}
};
//#endregion
//#region extensions/xiaomi/openclaw.plugin.json
var openclaw_plugin_default$1 = {
	id: "xiaomi",
	providers: ["xiaomi"],
	providerAuthEnvVars: { "xiaomi": ["XIAOMI_API_KEY"] },
	providerAuthChoices: [{
		"provider": "xiaomi",
		"method": "api-key",
		"choiceId": "xiaomi-api-key",
		"choiceLabel": "Xiaomi API key",
		"groupId": "xiaomi",
		"groupLabel": "Xiaomi",
		"groupHint": "API key",
		"optionKey": "xiaomiApiKey",
		"cliFlag": "--xiaomi-api-key",
		"cliOption": "--xiaomi-api-key <key>",
		"cliDescription": "Xiaomi API key"
	}],
	configSchema: {
		"type": "object",
		"additionalProperties": false,
		"properties": {}
	}
};
//#endregion
//#region extensions/zai/openclaw.plugin.json
var openclaw_plugin_default = {
	id: "zai",
	providers: ["zai"],
	providerAuthEnvVars: { "zai": ["ZAI_API_KEY", "Z_AI_API_KEY"] },
	providerAuthChoices: [
		{
			"provider": "zai",
			"method": "api-key",
			"choiceId": "zai-api-key",
			"choiceLabel": "Z.AI API key",
			"groupId": "zai",
			"groupLabel": "Z.AI",
			"groupHint": "GLM Coding Plan / Global / CN",
			"optionKey": "zaiApiKey",
			"cliFlag": "--zai-api-key",
			"cliOption": "--zai-api-key <key>",
			"cliDescription": "Z.AI API key"
		},
		{
			"provider": "zai",
			"method": "coding-global",
			"choiceId": "zai-coding-global",
			"choiceLabel": "Coding-Plan-Global",
			"choiceHint": "GLM Coding Plan Global (api.z.ai)",
			"groupId": "zai",
			"groupLabel": "Z.AI",
			"groupHint": "GLM Coding Plan / Global / CN",
			"optionKey": "zaiApiKey",
			"cliFlag": "--zai-api-key",
			"cliOption": "--zai-api-key <key>",
			"cliDescription": "Z.AI API key"
		},
		{
			"provider": "zai",
			"method": "coding-cn",
			"choiceId": "zai-coding-cn",
			"choiceLabel": "Coding-Plan-CN",
			"choiceHint": "GLM Coding Plan CN (open.bigmodel.cn)",
			"groupId": "zai",
			"groupLabel": "Z.AI",
			"groupHint": "GLM Coding Plan / Global / CN",
			"optionKey": "zaiApiKey",
			"cliFlag": "--zai-api-key",
			"cliOption": "--zai-api-key <key>",
			"cliDescription": "Z.AI API key"
		},
		{
			"provider": "zai",
			"method": "global",
			"choiceId": "zai-global",
			"choiceLabel": "Global",
			"choiceHint": "Z.AI Global (api.z.ai)",
			"groupId": "zai",
			"groupLabel": "Z.AI",
			"groupHint": "GLM Coding Plan / Global / CN",
			"optionKey": "zaiApiKey",
			"cliFlag": "--zai-api-key",
			"cliOption": "--zai-api-key <key>",
			"cliDescription": "Z.AI API key"
		},
		{
			"provider": "zai",
			"method": "cn",
			"choiceId": "zai-cn",
			"choiceLabel": "CN",
			"choiceHint": "Z.AI CN (open.bigmodel.cn)",
			"groupId": "zai",
			"groupLabel": "Z.AI",
			"groupHint": "GLM Coding Plan / Global / CN",
			"optionKey": "zaiApiKey",
			"cliFlag": "--zai-api-key",
			"cliOption": "--zai-api-key <key>",
			"cliDescription": "Z.AI API key"
		}
	],
	configSchema: {
		"type": "object",
		"additionalProperties": false,
		"properties": {}
	}
};
//#endregion
//#region src/plugins/bundled-provider-auth-env-vars.ts
function collectBundledProviderAuthEnvVars(manifests) {
	const entries = {};
	for (const manifest of manifests) {
		const providerAuthEnvVars = manifest.providerAuthEnvVars;
		if (!providerAuthEnvVars) {continue;}
		for (const [providerId, envVars] of Object.entries(providerAuthEnvVars)) {
			const normalizedProviderId = providerId.trim();
			const normalizedEnvVars = envVars.map((value) => value.trim()).filter(Boolean);
			if (!normalizedProviderId || normalizedEnvVars.length === 0) {continue;}
			entries[normalizedProviderId] = normalizedEnvVars;
		}
	}
	return entries;
}
const BUNDLED_PROVIDER_AUTH_ENV_VAR_CANDIDATES = collectBundledProviderAuthEnvVars([
	openclaw_plugin_default$30,
	openclaw_plugin_default$29,
	openclaw_plugin_default$28,
	openclaw_plugin_default$27,
	openclaw_plugin_default$26,
	openclaw_plugin_default$25,
	openclaw_plugin_default$24,
	openclaw_plugin_default$23,
	openclaw_plugin_default$22,
	openclaw_plugin_default$21,
	openclaw_plugin_default$20,
	openclaw_plugin_default$19,
	openclaw_plugin_default$18,
	openclaw_plugin_default$17,
	openclaw_plugin_default$16,
	openclaw_plugin_default$15,
	openclaw_plugin_default$14,
	openclaw_plugin_default$13,
	openclaw_plugin_default$12,
	openclaw_plugin_default$11,
	openclaw_plugin_default$10,
	openclaw_plugin_default$9,
	openclaw_plugin_default$8,
	openclaw_plugin_default$7,
	openclaw_plugin_default$6,
	openclaw_plugin_default$5,
	openclaw_plugin_default$4,
	openclaw_plugin_default$3,
	openclaw_plugin_default$2,
	openclaw_plugin_default$1,
	openclaw_plugin_default
]);
//#endregion
//#region src/secrets/provider-env-vars.ts
const CORE_PROVIDER_AUTH_ENV_VAR_CANDIDATES = {
	chutes: ["CHUTES_OAUTH_TOKEN", "CHUTES_API_KEY"],
	voyage: ["VOYAGE_API_KEY"],
	groq: ["GROQ_API_KEY"],
	deepgram: ["DEEPGRAM_API_KEY"],
	cerebras: ["CEREBRAS_API_KEY"],
	litellm: ["LITELLM_API_KEY"]
};
const CORE_PROVIDER_SETUP_ENV_VAR_OVERRIDES = {
	anthropic: ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"],
	chutes: ["CHUTES_API_KEY", "CHUTES_OAUTH_TOKEN"],
	"minimax-cn": ["MINIMAX_API_KEY"]
};
/**
* Provider auth env candidates used by generic auth resolution.
*
* Order matters: the first non-empty value wins for helpers such as
* `resolveEnvApiKey()`. Bundled providers source this from plugin manifest
* metadata so auth probes do not need to load plugin runtime.
*/
const PROVIDER_AUTH_ENV_VAR_CANDIDATES = {
	...BUNDLED_PROVIDER_AUTH_ENV_VAR_CANDIDATES,
	...CORE_PROVIDER_AUTH_ENV_VAR_CANDIDATES
};
/**
* Provider env vars used for setup/default secret refs and broad secret
* scrubbing. This can include non-model providers and may intentionally choose
* a different preferred first env var than auth resolution.
*
* Bundled provider auth envs come from plugin manifests. The override map here
* is only for true core/non-plugin providers and a few setup-specific ordering
* overrides where generic onboarding wants a different preferred env var.
*/
const PROVIDER_ENV_VARS = {
	...PROVIDER_AUTH_ENV_VAR_CANDIDATES,
	...CORE_PROVIDER_SETUP_ENV_VAR_OVERRIDES
};
const EXTRA_PROVIDER_AUTH_ENV_VARS = ["MINIMAX_CODE_PLAN_KEY"];
const KNOWN_SECRET_ENV_VARS = [...new Set(Object.values(PROVIDER_ENV_VARS).flatMap((keys) => keys))];
const KNOWN_PROVIDER_AUTH_ENV_VARS = [...new Set([
	...Object.values(PROVIDER_AUTH_ENV_VAR_CANDIDATES).flatMap((keys) => keys),
	...KNOWN_SECRET_ENV_VARS,
	...EXTRA_PROVIDER_AUTH_ENV_VARS
])];
function listKnownProviderAuthEnvVarNames() {
	return [...KNOWN_PROVIDER_AUTH_ENV_VARS];
}
function omitEnvKeysCaseInsensitive(baseEnv, keys) {
	const env = { ...baseEnv };
	const denied = /* @__PURE__ */ new Set();
	for (const key of keys) {
		const normalizedKey = key.trim();
		if (normalizedKey) {denied.add(normalizedKey.toUpperCase());}
	}
	if (denied.size === 0) {return env;}
	for (const actualKey of Object.keys(env)) {if (denied.has(actualKey.toUpperCase())) delete env[actualKey];}
	return env;
}
//#endregion
export { getAcpRuntimeBackend as a, unregisterAcpRuntimeBackend as c, isAcpRuntimeError as d, toAcpRuntimeError as f, omitEnvKeysCaseInsensitive as i, ACP_ERROR_CODES as l, PROVIDER_ENV_VARS as n, registerAcpRuntimeBackend as o, withAcpRuntimeErrorBoundary as p, listKnownProviderAuthEnvVarNames as r, requireAcpRuntimeBackend as s, PROVIDER_AUTH_ENV_VAR_CANDIDATES as t, AcpRuntimeError as u };
