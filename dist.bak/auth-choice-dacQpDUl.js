import { t as __exportAll } from "./rolldown-runtime-Cbj13DAv.js";
import { Br as CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF, Dn as resolveOpenClawAgentDir, Kn as resolveDefaultModelForAgent, Kr as KILOCODE_DEFAULT_MODEL_REF, Rr as discoverHuggingfaceModels, Tr as getCustomProviderApiKey, _n as upsertAuthProfile, bn as ensureAuthProfileStore, d as exchangeChutesCodeForTokens, f as generateChutesPkce, fr as VENICE_DEFAULT_MODEL_REF, kr as resolveEnvApiKey, mn as listProfilesForProvider, n as resolveAuthProfileOrder, p as parseOAuthCallbackInput, u as CHUTES_AUTHORIZE_ENDPOINT, yr as SYNTHETIC_DEFAULT_MODEL_REF, zr as isHuggingfacePolicyLocked } from "./auth-profiles-D6H-HVV8.js";
import { A as resolveDefaultAgentWorkspaceDir, P as toAgentModelListLike, a as resolveAgentDir, d as resolveDefaultAgentId, u as resolveAgentWorkspaceDir } from "./agent-scope-C2k6BQnt.js";
import { r as isLoopbackHost } from "./net-DBrsyv8q.js";
import { n as loadModelCatalog } from "./model-catalog-Def_bWVq.js";
import { f as openUrl } from "./onboard-helpers-CijgoJ1t.js";
import { t as enablePluginInConfig } from "./enable-DcrehKxk.js";
import { $ as ZAI_DEFAULT_MODEL_REF, A as applyTogetherConfig, B as applyLitellmConfig, C as applyMoonshotProviderConfigCn, Ct as writeOAuthCredentials, D as applyQianfanProviderConfig, Dt as QIANFAN_DEFAULT_MODEL_REF, E as applyQianfanConfig, Et as MOONSHOT_DEFAULT_MODEL_REF, F as applyXaiProviderConfig, G as applyVercelAiGatewayProviderConfig, H as applyCloudflareAiGatewayConfig, I as applyXiaomiConfig, J as LITELLM_DEFAULT_MODEL_REF, K as applyAgentDefaultModelPrimary, L as applyXiaomiProviderConfig, M as applyVeniceConfig, N as applyVeniceProviderConfig, O as applySyntheticConfig, Ot as XAI_DEFAULT_MODEL_REF, P as applyXaiConfig, Q as XIAOMI_DEFAULT_MODEL_REF, R as applyZaiConfig, S as applyMoonshotProviderConfig, St as setZaiApiKey, T as applyOpenrouterProviderConfig, Tt as MISTRAL_DEFAULT_MODEL_REF, U as applyCloudflareAiGatewayProviderConfig, V as applyLitellmProviderConfig, W as applyVercelAiGatewayConfig, X as TOGETHER_DEFAULT_MODEL_REF, Y as OPENROUTER_DEFAULT_MODEL_REF, Z as VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF, _ as applyKimiCodeProviderConfig, _t as setVeniceApiKey, a as applyMinimaxApiConfig, at as setKilocodeApiKey, b as applyMoonshotConfig, bt as setXaiApiKey, c as applyMinimaxApiProviderConfigCn, ct as setMinimaxApiKey, d as applyAuthProfileConfig, dt as setOpenaiApiKey, et as setAnthropicApiKey, ft as setOpencodeZenApiKey, g as applyKimiCodeConfig, gt as setTogetherApiKey, h as applyKilocodeProviderConfig, ht as setSyntheticApiKey, i as applyOpencodeZenProviderConfig, it as setHuggingfaceApiKey, j as applyTogetherProviderConfig, k as applySyntheticProviderConfig, l as applyMinimaxConfig, lt as setMistralApiKey, m as applyKilocodeConfig, mt as setQianfanApiKey, n as validateAnthropicSetupToken, nt as setCloudflareAiGatewayConfig, o as applyMinimaxApiConfigCn, ot as setKimiCodingApiKey, p as applyHuggingfaceProviderConfig, pt as setOpenrouterApiKey, q as HUGGINGFACE_DEFAULT_MODEL_REF, r as applyOpencodeZenConfig, rt as setGeminiApiKey, s as applyMinimaxApiProviderConfig, st as setLitellmApiKey, t as buildTokenProfileId, tt as setByteplusApiKey, u as applyMinimaxProviderConfig, ut as setMoonshotApiKey, v as applyMistralConfig, vt as setVercelAiGatewayApiKey, w as applyOpenrouterConfig, wt as KIMI_CODING_MODEL_REF, x as applyMoonshotConfigCn, xt as setXiaomiApiKey, y as applyMistralProviderConfig, yt as setVolcengineApiKey, z as applyZaiProviderConfig } from "./auth-token-1wFUIrL0.js";
import { a as createVpsAwareOAuthHandlers, c as githubCopilotLoginCommand, i as resolveProviderMatch, n as mergeConfigPatch, o as isRemoteEnvironment, r as pickAuthMethod, s as resolvePluginProviders, t as applyDefaultModel } from "./provider-auth-helpers-DnDTbcKF.js";
import { a as ensureApiKeyFromOptionEnvOrPrompt, c as applyDefaultModelChoice, d as validateApiKeyInput, l as ensureModelAllowlistEntry, n as createAuthChoiceDefaultModelApplier, o as normalizeSecretInputModeInput, r as createAuthChoiceModelStateBridge, s as normalizeTokenProviderInput, t as createAuthChoiceAgentModelNoter, u as normalizeApiKeyInput } from "./auth-choice.apply-helpers-Z8eSUe5X.js";
import { a as GOOGLE_GEMINI_DEFAULT_MODEL, i as detectZaiEndpoint, n as applyOpenAIConfig, o as applyGoogleGeminiModelDefault, r as applyOpenAIProviderConfig, t as OPENAI_DEFAULT_MODEL } from "./openai-model-default-DcZfcBEx.js";
import { c as OPENAI_CODEX_DEFAULT_MODEL, l as applyOpenAICodexModelDefault, r as applyPrimaryModel, s as promptAndConfigureVllm } from "./model-picker-Bj_Lb5H7.js";
import { loginOpenAICodex } from "@mariozechner/pi-ai";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

//#region src/commands/auth-choice.apply.anthropic.ts
const DEFAULT_ANTHROPIC_MODEL = "anthropic/claude-sonnet-4-6";
async function applyAuthChoiceAnthropic(params) {
	const requestedSecretInputMode = normalizeSecretInputModeInput(params.opts?.secretInputMode);
	if (params.authChoice === "setup-token" || params.authChoice === "oauth" || params.authChoice === "token") {
		let nextConfig = params.config;
		await params.prompter.note(["Run `claude setup-token` in your terminal.", "Then paste the generated token below."].join("\n"), "Anthropic setup-token");
		const tokenRaw = await params.prompter.text({
			message: "Paste Anthropic setup-token",
			validate: (value) => validateAnthropicSetupToken(String(value ?? ""))
		});
		const token = String(tokenRaw ?? "").trim();
		const profileNameRaw = await params.prompter.text({
			message: "Token name (blank = default)",
			placeholder: "default"
		});
		const provider = "anthropic";
		const namedProfileId = buildTokenProfileId({
			provider,
			name: String(profileNameRaw ?? "")
		});
		upsertAuthProfile({
			profileId: namedProfileId,
			agentDir: params.agentDir,
			credential: {
				type: "token",
				provider,
				token
			}
		});
		nextConfig = applyAuthProfileConfig(nextConfig, {
			profileId: namedProfileId,
			provider,
			mode: "token"
		});
		if (params.setDefaultModel) nextConfig = applyAgentDefaultModelPrimary(nextConfig, DEFAULT_ANTHROPIC_MODEL);
		return { config: nextConfig };
	}
	if (params.authChoice === "apiKey") {
		if (params.opts?.tokenProvider && params.opts.tokenProvider !== "anthropic") return null;
		let nextConfig = params.config;
		await ensureApiKeyFromOptionEnvOrPrompt({
			token: params.opts?.token,
			tokenProvider: params.opts?.tokenProvider ?? "anthropic",
			secretInputMode: requestedSecretInputMode,
			config: nextConfig,
			expectedProviders: ["anthropic"],
			provider: "anthropic",
			envLabel: "ANTHROPIC_API_KEY",
			promptMessage: "Enter Anthropic API key",
			normalize: normalizeApiKeyInput,
			validate: validateApiKeyInput,
			prompter: params.prompter,
			setCredential: async (apiKey, mode) => setAnthropicApiKey(apiKey, params.agentDir, { secretInputMode: mode })
		});
		nextConfig = applyAuthProfileConfig(nextConfig, {
			profileId: "anthropic:default",
			provider: "anthropic",
			mode: "api_key"
		});
		if (params.setDefaultModel) nextConfig = applyAgentDefaultModelPrimary(nextConfig, DEFAULT_ANTHROPIC_MODEL);
		return { config: nextConfig };
	}
	return null;
}

//#endregion
//#region src/commands/auth-choice.apply.huggingface.ts
async function applyAuthChoiceHuggingface(params) {
	if (params.authChoice !== "huggingface-api-key") return null;
	let nextConfig = params.config;
	let agentModelOverride;
	const noteAgentModel = createAuthChoiceAgentModelNoter(params);
	const requestedSecretInputMode = normalizeSecretInputModeInput(params.opts?.secretInputMode);
	const hfKey = await ensureApiKeyFromOptionEnvOrPrompt({
		token: params.opts?.token,
		tokenProvider: params.opts?.tokenProvider,
		secretInputMode: requestedSecretInputMode,
		config: nextConfig,
		expectedProviders: ["huggingface"],
		provider: "huggingface",
		envLabel: "Hugging Face token",
		promptMessage: "Enter Hugging Face API key (HF token)",
		normalize: normalizeApiKeyInput,
		validate: validateApiKeyInput,
		prompter: params.prompter,
		setCredential: async (apiKey, mode) => setHuggingfaceApiKey(apiKey, params.agentDir, { secretInputMode: mode }),
		noteMessage: ["Hugging Face Inference Providers offer OpenAI-compatible chat completions.", "Create a token at: https://huggingface.co/settings/tokens (fine-grained, 'Make calls to Inference Providers')."].join("\n"),
		noteTitle: "Hugging Face"
	});
	nextConfig = applyAuthProfileConfig(nextConfig, {
		profileId: "huggingface:default",
		provider: "huggingface",
		mode: "api_key"
	});
	const models = await discoverHuggingfaceModels(hfKey);
	const modelRefPrefix = "huggingface/";
	const options = [];
	for (const m of models) {
		const baseRef = `${modelRefPrefix}${m.id}`;
		const label = m.name ?? m.id;
		options.push({
			value: baseRef,
			label
		});
		options.push({
			value: `${baseRef}:cheapest`,
			label: `${label} (cheapest)`
		});
		options.push({
			value: `${baseRef}:fastest`,
			label: `${label} (fastest)`
		});
	}
	const defaultRef = HUGGINGFACE_DEFAULT_MODEL_REF;
	options.sort((a, b) => {
		if (a.value === defaultRef) return -1;
		if (b.value === defaultRef) return 1;
		return a.label.localeCompare(b.label, void 0, { sensitivity: "base" });
	});
	const selectedModelRef = options.length === 0 ? defaultRef : options.length === 1 ? options[0].value : await params.prompter.select({
		message: "Default Hugging Face model",
		options,
		initialValue: options.some((o) => o.value === defaultRef) ? defaultRef : options[0].value
	});
	if (isHuggingfacePolicyLocked(selectedModelRef)) await params.prompter.note("Provider locked — router will choose backend by cost or speed.", "Hugging Face");
	const applied = await applyDefaultModelChoice({
		config: nextConfig,
		setDefaultModel: params.setDefaultModel,
		defaultModel: selectedModelRef,
		applyDefaultConfig: (config) => {
			const withProvider = applyHuggingfaceProviderConfig(config);
			const existingModel = withProvider.agents?.defaults?.model;
			return ensureModelAllowlistEntry({
				cfg: {
					...withProvider,
					agents: {
						...withProvider.agents,
						defaults: {
							...withProvider.agents?.defaults,
							model: {
								...existingModel && typeof existingModel === "object" && "fallbacks" in existingModel ? { fallbacks: existingModel.fallbacks } : {},
								primary: selectedModelRef
							}
						}
					}
				},
				modelRef: selectedModelRef
			});
		},
		applyProviderConfig: applyHuggingfaceProviderConfig,
		noteDefault: selectedModelRef,
		noteAgentModel,
		prompter: params.prompter
	});
	nextConfig = applied.config;
	agentModelOverride = applied.agentModelOverride ?? agentModelOverride;
	return {
		config: nextConfig,
		agentModelOverride
	};
}

//#endregion
//#region src/commands/auth-choice.apply.openrouter.ts
async function applyAuthChoiceOpenRouter(params) {
	let nextConfig = params.config;
	let agentModelOverride;
	const noteAgentModel = createAuthChoiceAgentModelNoter(params);
	const requestedSecretInputMode = normalizeSecretInputModeInput(params.opts?.secretInputMode);
	const store = ensureAuthProfileStore(params.agentDir, { allowKeychainPrompt: false });
	const existingProfileId = resolveAuthProfileOrder({
		cfg: nextConfig,
		store,
		provider: "openrouter"
	}).find((profileId) => Boolean(store.profiles[profileId]));
	const existingCred = existingProfileId ? store.profiles[existingProfileId] : void 0;
	let profileId = "openrouter:default";
	let mode = "api_key";
	let hasCredential = false;
	if (existingProfileId && existingCred?.type) {
		profileId = existingProfileId;
		mode = existingCred.type === "oauth" ? "oauth" : existingCred.type === "token" ? "token" : "api_key";
		hasCredential = true;
	}
	if (!hasCredential && params.opts?.token && params.opts?.tokenProvider === "openrouter") {
		await setOpenrouterApiKey(normalizeApiKeyInput(params.opts.token), params.agentDir, { secretInputMode: requestedSecretInputMode });
		hasCredential = true;
	}
	if (!hasCredential) {
		await ensureApiKeyFromOptionEnvOrPrompt({
			token: params.opts?.token,
			tokenProvider: params.opts?.tokenProvider,
			secretInputMode: requestedSecretInputMode,
			config: nextConfig,
			expectedProviders: ["openrouter"],
			provider: "openrouter",
			envLabel: "OPENROUTER_API_KEY",
			promptMessage: "Enter OpenRouter API key",
			normalize: normalizeApiKeyInput,
			validate: validateApiKeyInput,
			prompter: params.prompter,
			setCredential: async (apiKey, mode) => setOpenrouterApiKey(apiKey, params.agentDir, { secretInputMode: mode })
		});
		hasCredential = true;
	}
	if (hasCredential) nextConfig = applyAuthProfileConfig(nextConfig, {
		profileId,
		provider: "openrouter",
		mode
	});
	const applied = await applyDefaultModelChoice({
		config: nextConfig,
		setDefaultModel: params.setDefaultModel,
		defaultModel: OPENROUTER_DEFAULT_MODEL_REF,
		applyDefaultConfig: applyOpenrouterConfig,
		applyProviderConfig: applyOpenrouterProviderConfig,
		noteDefault: OPENROUTER_DEFAULT_MODEL_REF,
		noteAgentModel,
		prompter: params.prompter
	});
	nextConfig = applied.config;
	agentModelOverride = applied.agentModelOverride ?? agentModelOverride;
	return {
		config: nextConfig,
		agentModelOverride
	};
}

//#endregion
//#region src/commands/opencode-zen-model-default.ts
const OPENCODE_ZEN_DEFAULT_MODEL = "opencode/claude-opus-4-6";

//#endregion
//#region src/commands/auth-choice.apply.api-providers.ts
const API_KEY_TOKEN_PROVIDER_AUTH_CHOICE = {
	openrouter: "openrouter-api-key",
	litellm: "litellm-api-key",
	"vercel-ai-gateway": "ai-gateway-api-key",
	"cloudflare-ai-gateway": "cloudflare-ai-gateway-api-key",
	moonshot: "moonshot-api-key",
	"kimi-code": "kimi-code-api-key",
	"kimi-coding": "kimi-code-api-key",
	google: "gemini-api-key",
	zai: "zai-api-key",
	xiaomi: "xiaomi-api-key",
	synthetic: "synthetic-api-key",
	venice: "venice-api-key",
	together: "together-api-key",
	huggingface: "huggingface-api-key",
	mistral: "mistral-api-key",
	opencode: "opencode-zen",
	kilocode: "kilocode-api-key",
	qianfan: "qianfan-api-key"
};
const ZAI_AUTH_CHOICE_ENDPOINT = {
	"zai-coding-global": "coding-global",
	"zai-coding-cn": "coding-cn",
	"zai-global": "global",
	"zai-cn": "cn"
};
const SIMPLE_API_KEY_PROVIDER_FLOWS = {
	"ai-gateway-api-key": {
		provider: "vercel-ai-gateway",
		profileId: "vercel-ai-gateway:default",
		expectedProviders: ["vercel-ai-gateway"],
		envLabel: "AI_GATEWAY_API_KEY",
		promptMessage: "Enter Vercel AI Gateway API key",
		setCredential: setVercelAiGatewayApiKey,
		defaultModel: VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF,
		applyDefaultConfig: applyVercelAiGatewayConfig,
		applyProviderConfig: applyVercelAiGatewayProviderConfig,
		noteDefault: VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF
	},
	"moonshot-api-key": {
		provider: "moonshot",
		profileId: "moonshot:default",
		expectedProviders: ["moonshot"],
		envLabel: "MOONSHOT_API_KEY",
		promptMessage: "Enter Moonshot API key",
		setCredential: setMoonshotApiKey,
		defaultModel: MOONSHOT_DEFAULT_MODEL_REF,
		applyDefaultConfig: applyMoonshotConfig,
		applyProviderConfig: applyMoonshotProviderConfig
	},
	"moonshot-api-key-cn": {
		provider: "moonshot",
		profileId: "moonshot:default",
		expectedProviders: ["moonshot"],
		envLabel: "MOONSHOT_API_KEY",
		promptMessage: "Enter Moonshot API key (.cn)",
		setCredential: setMoonshotApiKey,
		defaultModel: MOONSHOT_DEFAULT_MODEL_REF,
		applyDefaultConfig: applyMoonshotConfigCn,
		applyProviderConfig: applyMoonshotProviderConfigCn
	},
	"kimi-code-api-key": {
		provider: "kimi-coding",
		profileId: "kimi-coding:default",
		expectedProviders: ["kimi-code", "kimi-coding"],
		envLabel: "KIMI_API_KEY",
		promptMessage: "Enter Kimi Coding API key",
		setCredential: setKimiCodingApiKey,
		defaultModel: KIMI_CODING_MODEL_REF,
		applyDefaultConfig: applyKimiCodeConfig,
		applyProviderConfig: applyKimiCodeProviderConfig,
		noteDefault: KIMI_CODING_MODEL_REF,
		noteMessage: ["Kimi Coding uses a dedicated endpoint and API key.", "Get your API key at: https://www.kimi.com/code/en"].join("\n"),
		noteTitle: "Kimi Coding"
	},
	"xiaomi-api-key": {
		provider: "xiaomi",
		profileId: "xiaomi:default",
		expectedProviders: ["xiaomi"],
		envLabel: "XIAOMI_API_KEY",
		promptMessage: "Enter Xiaomi API key",
		setCredential: setXiaomiApiKey,
		defaultModel: XIAOMI_DEFAULT_MODEL_REF,
		applyDefaultConfig: applyXiaomiConfig,
		applyProviderConfig: applyXiaomiProviderConfig,
		noteDefault: XIAOMI_DEFAULT_MODEL_REF
	},
	"mistral-api-key": {
		provider: "mistral",
		profileId: "mistral:default",
		expectedProviders: ["mistral"],
		envLabel: "MISTRAL_API_KEY",
		promptMessage: "Enter Mistral API key",
		setCredential: setMistralApiKey,
		defaultModel: MISTRAL_DEFAULT_MODEL_REF,
		applyDefaultConfig: applyMistralConfig,
		applyProviderConfig: applyMistralProviderConfig,
		noteDefault: MISTRAL_DEFAULT_MODEL_REF
	},
	"venice-api-key": {
		provider: "venice",
		profileId: "venice:default",
		expectedProviders: ["venice"],
		envLabel: "VENICE_API_KEY",
		promptMessage: "Enter Venice AI API key",
		setCredential: setVeniceApiKey,
		defaultModel: VENICE_DEFAULT_MODEL_REF,
		applyDefaultConfig: applyVeniceConfig,
		applyProviderConfig: applyVeniceProviderConfig,
		noteDefault: VENICE_DEFAULT_MODEL_REF,
		noteMessage: [
			"Venice AI provides privacy-focused inference with uncensored models.",
			"Get your API key at: https://venice.ai/settings/api",
			"Supports 'private' (fully private) and 'anonymized' (proxy) modes."
		].join("\n"),
		noteTitle: "Venice AI"
	},
	"opencode-zen": {
		provider: "opencode",
		profileId: "opencode:default",
		expectedProviders: ["opencode"],
		envLabel: "OPENCODE_API_KEY",
		promptMessage: "Enter OpenCode Zen API key",
		setCredential: setOpencodeZenApiKey,
		defaultModel: OPENCODE_ZEN_DEFAULT_MODEL,
		applyDefaultConfig: applyOpencodeZenConfig,
		applyProviderConfig: applyOpencodeZenProviderConfig,
		noteDefault: OPENCODE_ZEN_DEFAULT_MODEL,
		noteMessage: [
			"OpenCode Zen provides access to Claude, GPT, Gemini, and more models.",
			"Get your API key at: https://opencode.ai/auth",
			"OpenCode Zen bills per request. Check your OpenCode dashboard for details."
		].join("\n"),
		noteTitle: "OpenCode Zen"
	},
	"together-api-key": {
		provider: "together",
		profileId: "together:default",
		expectedProviders: ["together"],
		envLabel: "TOGETHER_API_KEY",
		promptMessage: "Enter Together AI API key",
		setCredential: setTogetherApiKey,
		defaultModel: TOGETHER_DEFAULT_MODEL_REF,
		applyDefaultConfig: applyTogetherConfig,
		applyProviderConfig: applyTogetherProviderConfig,
		noteDefault: TOGETHER_DEFAULT_MODEL_REF,
		noteMessage: ["Together AI provides access to leading open-source models including Llama, DeepSeek, Qwen, and more.", "Get your API key at: https://api.together.xyz/settings/api-keys"].join("\n"),
		noteTitle: "Together AI"
	},
	"qianfan-api-key": {
		provider: "qianfan",
		profileId: "qianfan:default",
		expectedProviders: ["qianfan"],
		envLabel: "QIANFAN_API_KEY",
		promptMessage: "Enter QIANFAN API key",
		setCredential: setQianfanApiKey,
		defaultModel: QIANFAN_DEFAULT_MODEL_REF,
		applyDefaultConfig: applyQianfanConfig,
		applyProviderConfig: applyQianfanProviderConfig,
		noteDefault: QIANFAN_DEFAULT_MODEL_REF,
		noteMessage: ["Get your API key at: https://console.bce.baidu.com/qianfan/ais/console/apiKey", "API key format: bce-v3/ALTAK-..."].join("\n"),
		noteTitle: "QIANFAN"
	},
	"kilocode-api-key": {
		provider: "kilocode",
		profileId: "kilocode:default",
		expectedProviders: ["kilocode"],
		envLabel: "KILOCODE_API_KEY",
		promptMessage: "Enter Kilo Gateway API key",
		setCredential: setKilocodeApiKey,
		defaultModel: KILOCODE_DEFAULT_MODEL_REF,
		applyDefaultConfig: applyKilocodeConfig,
		applyProviderConfig: applyKilocodeProviderConfig,
		noteDefault: KILOCODE_DEFAULT_MODEL_REF
	},
	"synthetic-api-key": {
		provider: "synthetic",
		profileId: "synthetic:default",
		expectedProviders: ["synthetic"],
		envLabel: "SYNTHETIC_API_KEY",
		promptMessage: "Enter Synthetic API key",
		setCredential: setSyntheticApiKey,
		defaultModel: SYNTHETIC_DEFAULT_MODEL_REF,
		applyDefaultConfig: applySyntheticConfig,
		applyProviderConfig: applySyntheticProviderConfig,
		normalize: (value) => String(value ?? "").trim(),
		validate: (value) => String(value ?? "").trim() ? void 0 : "Required"
	}
};
async function applyAuthChoiceApiProviders(params) {
	let nextConfig = params.config;
	let agentModelOverride;
	const noteAgentModel = createAuthChoiceAgentModelNoter(params);
	const applyProviderDefaultModel = createAuthChoiceDefaultModelApplier(params, createAuthChoiceModelStateBridge({
		getConfig: () => nextConfig,
		setConfig: (config) => nextConfig = config,
		getAgentModelOverride: () => agentModelOverride,
		setAgentModelOverride: (model) => agentModelOverride = model
	}));
	let authChoice = params.authChoice;
	const normalizedTokenProvider = normalizeTokenProviderInput(params.opts?.tokenProvider);
	const requestedSecretInputMode = normalizeSecretInputModeInput(params.opts?.secretInputMode);
	if (authChoice === "apiKey" && params.opts?.tokenProvider) {
		if (normalizedTokenProvider !== "anthropic" && normalizedTokenProvider !== "openai") authChoice = API_KEY_TOKEN_PROVIDER_AUTH_CHOICE[normalizedTokenProvider ?? ""] ?? authChoice;
	}
	async function applyApiKeyProviderWithDefaultModel({ provider, profileId, expectedProviders, envLabel, promptMessage, setCredential, defaultModel, applyDefaultConfig, applyProviderConfig, noteMessage, noteTitle, tokenProvider = normalizedTokenProvider, normalize = normalizeApiKeyInput, validate = validateApiKeyInput, noteDefault = defaultModel }) {
		await ensureApiKeyFromOptionEnvOrPrompt({
			token: params.opts?.token,
			provider,
			tokenProvider,
			secretInputMode: requestedSecretInputMode,
			config: nextConfig,
			expectedProviders,
			envLabel,
			promptMessage,
			setCredential: async (apiKey, mode) => {
				await setCredential(apiKey, mode);
			},
			noteMessage,
			noteTitle,
			normalize,
			validate,
			prompter: params.prompter
		});
		nextConfig = applyAuthProfileConfig(nextConfig, {
			profileId,
			provider,
			mode: "api_key"
		});
		await applyProviderDefaultModel({
			defaultModel,
			applyDefaultConfig,
			applyProviderConfig,
			noteDefault
		});
		return {
			config: nextConfig,
			agentModelOverride
		};
	}
	if (authChoice === "openrouter-api-key") return applyAuthChoiceOpenRouter(params);
	if (authChoice === "litellm-api-key") {
		const store = ensureAuthProfileStore(params.agentDir, { allowKeychainPrompt: false });
		const existingProfileId = resolveAuthProfileOrder({
			cfg: nextConfig,
			store,
			provider: "litellm"
		}).find((profileId) => Boolean(store.profiles[profileId]));
		const existingCred = existingProfileId ? store.profiles[existingProfileId] : void 0;
		let profileId = "litellm:default";
		let hasCredential = Boolean(existingProfileId && existingCred?.type === "api_key");
		if (hasCredential && existingProfileId) profileId = existingProfileId;
		if (!hasCredential) {
			await ensureApiKeyFromOptionEnvOrPrompt({
				token: params.opts?.token,
				tokenProvider: normalizedTokenProvider,
				secretInputMode: requestedSecretInputMode,
				config: nextConfig,
				expectedProviders: ["litellm"],
				provider: "litellm",
				envLabel: "LITELLM_API_KEY",
				promptMessage: "Enter LiteLLM API key",
				normalize: normalizeApiKeyInput,
				validate: validateApiKeyInput,
				prompter: params.prompter,
				setCredential: async (apiKey, mode) => setLitellmApiKey(apiKey, params.agentDir, { secretInputMode: mode }),
				noteMessage: "LiteLLM provides a unified API to 100+ LLM providers.\nGet your API key from your LiteLLM proxy or https://litellm.ai\nDefault proxy runs on http://localhost:4000",
				noteTitle: "LiteLLM"
			});
			hasCredential = true;
		}
		if (hasCredential) nextConfig = applyAuthProfileConfig(nextConfig, {
			profileId,
			provider: "litellm",
			mode: "api_key"
		});
		await applyProviderDefaultModel({
			defaultModel: LITELLM_DEFAULT_MODEL_REF,
			applyDefaultConfig: applyLitellmConfig,
			applyProviderConfig: applyLitellmProviderConfig,
			noteDefault: LITELLM_DEFAULT_MODEL_REF
		});
		return {
			config: nextConfig,
			agentModelOverride
		};
	}
	const simpleApiKeyProviderFlow = SIMPLE_API_KEY_PROVIDER_FLOWS[authChoice];
	if (simpleApiKeyProviderFlow) return await applyApiKeyProviderWithDefaultModel({
		provider: simpleApiKeyProviderFlow.provider,
		profileId: simpleApiKeyProviderFlow.profileId,
		expectedProviders: simpleApiKeyProviderFlow.expectedProviders,
		envLabel: simpleApiKeyProviderFlow.envLabel,
		promptMessage: simpleApiKeyProviderFlow.promptMessage,
		setCredential: async (apiKey, mode) => simpleApiKeyProviderFlow.setCredential(apiKey, params.agentDir, { secretInputMode: mode ?? requestedSecretInputMode }),
		defaultModel: simpleApiKeyProviderFlow.defaultModel,
		applyDefaultConfig: simpleApiKeyProviderFlow.applyDefaultConfig,
		applyProviderConfig: simpleApiKeyProviderFlow.applyProviderConfig,
		noteDefault: simpleApiKeyProviderFlow.noteDefault,
		noteMessage: simpleApiKeyProviderFlow.noteMessage,
		noteTitle: simpleApiKeyProviderFlow.noteTitle,
		tokenProvider: simpleApiKeyProviderFlow.tokenProvider,
		normalize: simpleApiKeyProviderFlow.normalize,
		validate: simpleApiKeyProviderFlow.validate
	});
	if (authChoice === "cloudflare-ai-gateway-api-key") {
		let accountId = params.opts?.cloudflareAiGatewayAccountId?.trim() ?? "";
		let gatewayId = params.opts?.cloudflareAiGatewayGatewayId?.trim() ?? "";
		const ensureAccountGateway = async () => {
			if (!accountId) {
				const value = await params.prompter.text({
					message: "Enter Cloudflare Account ID",
					validate: (val) => String(val ?? "").trim() ? void 0 : "Account ID is required"
				});
				accountId = String(value ?? "").trim();
			}
			if (!gatewayId) {
				const value = await params.prompter.text({
					message: "Enter Cloudflare AI Gateway ID",
					validate: (val) => String(val ?? "").trim() ? void 0 : "Gateway ID is required"
				});
				gatewayId = String(value ?? "").trim();
			}
		};
		await ensureAccountGateway();
		await ensureApiKeyFromOptionEnvOrPrompt({
			token: params.opts?.cloudflareAiGatewayApiKey,
			tokenProvider: "cloudflare-ai-gateway",
			secretInputMode: requestedSecretInputMode,
			config: nextConfig,
			expectedProviders: ["cloudflare-ai-gateway"],
			provider: "cloudflare-ai-gateway",
			envLabel: "CLOUDFLARE_AI_GATEWAY_API_KEY",
			promptMessage: "Enter Cloudflare AI Gateway API key",
			normalize: normalizeApiKeyInput,
			validate: validateApiKeyInput,
			prompter: params.prompter,
			setCredential: async (apiKey, mode) => setCloudflareAiGatewayConfig(accountId, gatewayId, apiKey, params.agentDir, { secretInputMode: mode })
		});
		nextConfig = applyAuthProfileConfig(nextConfig, {
			profileId: "cloudflare-ai-gateway:default",
			provider: "cloudflare-ai-gateway",
			mode: "api_key"
		});
		await applyProviderDefaultModel({
			defaultModel: CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF,
			applyDefaultConfig: (cfg) => applyCloudflareAiGatewayConfig(cfg, {
				accountId: accountId || params.opts?.cloudflareAiGatewayAccountId,
				gatewayId: gatewayId || params.opts?.cloudflareAiGatewayGatewayId
			}),
			applyProviderConfig: (cfg) => applyCloudflareAiGatewayProviderConfig(cfg, {
				accountId: accountId || params.opts?.cloudflareAiGatewayAccountId,
				gatewayId: gatewayId || params.opts?.cloudflareAiGatewayGatewayId
			}),
			noteDefault: CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF
		});
		return {
			config: nextConfig,
			agentModelOverride
		};
	}
	if (authChoice === "gemini-api-key") {
		await ensureApiKeyFromOptionEnvOrPrompt({
			token: params.opts?.token,
			provider: "google",
			tokenProvider: normalizedTokenProvider,
			secretInputMode: requestedSecretInputMode,
			config: nextConfig,
			expectedProviders: ["google"],
			envLabel: "GEMINI_API_KEY",
			promptMessage: "Enter Gemini API key",
			normalize: normalizeApiKeyInput,
			validate: validateApiKeyInput,
			prompter: params.prompter,
			setCredential: async (apiKey, mode) => setGeminiApiKey(apiKey, params.agentDir, { secretInputMode: mode })
		});
		nextConfig = applyAuthProfileConfig(nextConfig, {
			profileId: "google:default",
			provider: "google",
			mode: "api_key"
		});
		if (params.setDefaultModel) {
			const applied = applyGoogleGeminiModelDefault(nextConfig);
			nextConfig = applied.next;
			if (applied.changed) await params.prompter.note(`Default model set to ${GOOGLE_GEMINI_DEFAULT_MODEL}`, "Model configured");
		} else {
			agentModelOverride = GOOGLE_GEMINI_DEFAULT_MODEL;
			await noteAgentModel(GOOGLE_GEMINI_DEFAULT_MODEL);
		}
		return {
			config: nextConfig,
			agentModelOverride
		};
	}
	if (authChoice === "zai-api-key" || authChoice === "zai-coding-global" || authChoice === "zai-coding-cn" || authChoice === "zai-global" || authChoice === "zai-cn") {
		let endpoint = ZAI_AUTH_CHOICE_ENDPOINT[authChoice];
		const apiKey = await ensureApiKeyFromOptionEnvOrPrompt({
			token: params.opts?.token,
			provider: "zai",
			tokenProvider: normalizedTokenProvider,
			secretInputMode: requestedSecretInputMode,
			config: nextConfig,
			expectedProviders: ["zai"],
			envLabel: "ZAI_API_KEY",
			promptMessage: "Enter Z.AI API key",
			normalize: normalizeApiKeyInput,
			validate: validateApiKeyInput,
			prompter: params.prompter,
			setCredential: async (apiKey, mode) => setZaiApiKey(apiKey, params.agentDir, { secretInputMode: mode })
		});
		let modelIdOverride;
		if (!endpoint) {
			const detected = await detectZaiEndpoint({ apiKey });
			if (detected) {
				endpoint = detected.endpoint;
				modelIdOverride = detected.modelId;
				await params.prompter.note(detected.note, "Z.AI endpoint");
			} else endpoint = await params.prompter.select({
				message: "Select Z.AI endpoint",
				options: [
					{
						value: "coding-global",
						label: "Coding-Plan-Global",
						hint: "GLM Coding Plan Global (api.z.ai)"
					},
					{
						value: "coding-cn",
						label: "Coding-Plan-CN",
						hint: "GLM Coding Plan CN (open.bigmodel.cn)"
					},
					{
						value: "global",
						label: "Global",
						hint: "Z.AI Global (api.z.ai)"
					},
					{
						value: "cn",
						label: "CN",
						hint: "Z.AI CN (open.bigmodel.cn)"
					}
				],
				initialValue: "global"
			});
		}
		nextConfig = applyAuthProfileConfig(nextConfig, {
			profileId: "zai:default",
			provider: "zai",
			mode: "api_key"
		});
		const defaultModel = modelIdOverride ? `zai/${modelIdOverride}` : ZAI_DEFAULT_MODEL_REF;
		await applyProviderDefaultModel({
			defaultModel,
			applyDefaultConfig: (config) => applyZaiConfig(config, {
				endpoint,
				...modelIdOverride ? { modelId: modelIdOverride } : {}
			}),
			applyProviderConfig: (config) => applyZaiProviderConfig(config, {
				endpoint,
				...modelIdOverride ? { modelId: modelIdOverride } : {}
			}),
			noteDefault: defaultModel
		});
		return {
			config: nextConfig,
			agentModelOverride
		};
	}
	if (authChoice === "huggingface-api-key") return applyAuthChoiceHuggingface({
		...params,
		authChoice
	});
	return null;
}

//#endregion
//#region src/commands/auth-choice.apply.byteplus.ts
/** Default model for BytePlus auth onboarding. */
const BYTEPLUS_DEFAULT_MODEL = "byteplus-plan/ark-code-latest";
async function applyAuthChoiceBytePlus(params) {
	if (params.authChoice !== "byteplus-api-key") return null;
	const requestedSecretInputMode = normalizeSecretInputModeInput(params.opts?.secretInputMode);
	await ensureApiKeyFromOptionEnvOrPrompt({
		token: params.opts?.byteplusApiKey,
		tokenProvider: "byteplus",
		secretInputMode: requestedSecretInputMode,
		config: params.config,
		expectedProviders: ["byteplus"],
		provider: "byteplus",
		envLabel: "BYTEPLUS_API_KEY",
		promptMessage: "Enter BytePlus API key",
		normalize: normalizeApiKeyInput,
		validate: validateApiKeyInput,
		prompter: params.prompter,
		setCredential: async (apiKey, mode) => setByteplusApiKey(apiKey, params.agentDir, { secretInputMode: mode })
	});
	return {
		config: applyPrimaryModel(applyAuthProfileConfig(params.config, {
			profileId: "byteplus:default",
			provider: "byteplus",
			mode: "api_key"
		}), BYTEPLUS_DEFAULT_MODEL),
		agentModelOverride: BYTEPLUS_DEFAULT_MODEL
	};
}

//#endregion
//#region src/commands/auth-choice.apply.plugin-provider.ts
async function applyAuthChoicePluginProvider(params, options) {
	if (params.authChoice !== options.authChoice) return null;
	const enableResult = enablePluginInConfig(params.config, options.pluginId);
	let nextConfig = enableResult.config;
	if (!enableResult.enabled) {
		await params.prompter.note(`${options.label} plugin is disabled (${enableResult.reason ?? "blocked"}).`, options.label);
		return { config: nextConfig };
	}
	const agentId = params.agentId ?? resolveDefaultAgentId(nextConfig);
	const defaultAgentId = resolveDefaultAgentId(nextConfig);
	const agentDir = params.agentDir ?? (agentId === defaultAgentId ? resolveOpenClawAgentDir() : resolveAgentDir(nextConfig, agentId));
	const workspaceDir = resolveAgentWorkspaceDir(nextConfig, agentId) ?? resolveDefaultAgentWorkspaceDir();
	const provider = resolveProviderMatch(resolvePluginProviders({
		config: nextConfig,
		workspaceDir
	}), options.providerId);
	if (!provider) {
		await params.prompter.note(`${options.label} auth plugin is not available. Enable it and re-run the wizard.`, options.label);
		return { config: nextConfig };
	}
	const method = pickAuthMethod(provider, options.methodId) ?? provider.auth[0];
	if (!method) {
		await params.prompter.note(`${options.label} auth method missing.`, options.label);
		return { config: nextConfig };
	}
	const isRemote = isRemoteEnvironment();
	const result = await method.run({
		config: nextConfig,
		agentDir,
		workspaceDir,
		prompter: params.prompter,
		runtime: params.runtime,
		isRemote,
		openUrl: async (url) => {
			await openUrl(url);
		},
		oauth: { createVpsAwareHandlers: (opts) => createVpsAwareOAuthHandlers(opts) }
	});
	if (result.configPatch) nextConfig = mergeConfigPatch(nextConfig, result.configPatch);
	for (const profile of result.profiles) {
		upsertAuthProfile({
			profileId: profile.profileId,
			credential: profile.credential,
			agentDir
		});
		nextConfig = applyAuthProfileConfig(nextConfig, {
			profileId: profile.profileId,
			provider: profile.credential.provider,
			mode: profile.credential.type === "token" ? "token" : profile.credential.type,
			..."email" in profile.credential && profile.credential.email ? { email: profile.credential.email } : {}
		});
	}
	let agentModelOverride;
	if (result.defaultModel) {
		if (params.setDefaultModel) {
			nextConfig = applyDefaultModel(nextConfig, result.defaultModel);
			await params.prompter.note(`Default model set to ${result.defaultModel}`, "Model configured");
		} else if (params.agentId) {
			agentModelOverride = result.defaultModel;
			await params.prompter.note(`Default model set to ${result.defaultModel} for agent "${params.agentId}".`, "Model configured");
		}
	}
	if (result.notes && result.notes.length > 0) await params.prompter.note(result.notes.join("\n"), "Provider notes");
	return {
		config: nextConfig,
		agentModelOverride
	};
}

//#endregion
//#region src/commands/auth-choice.apply.copilot-proxy.ts
async function applyAuthChoiceCopilotProxy(params) {
	return await applyAuthChoicePluginProvider(params, {
		authChoice: "copilot-proxy",
		pluginId: "copilot-proxy",
		providerId: "copilot-proxy",
		methodId: "local",
		label: "Copilot Proxy"
	});
}

//#endregion
//#region src/commands/auth-choice.apply.github-copilot.ts
async function applyAuthChoiceGitHubCopilot(params) {
	if (params.authChoice !== "github-copilot") return null;
	let nextConfig = params.config;
	await params.prompter.note(["This will open a GitHub device login to authorize Copilot.", "Requires an active GitHub Copilot subscription."].join("\n"), "GitHub Copilot");
	if (!process.stdin.isTTY) {
		await params.prompter.note("GitHub Copilot login requires an interactive TTY.", "GitHub Copilot");
		return { config: nextConfig };
	}
	try {
		await githubCopilotLoginCommand({ yes: true }, params.runtime);
	} catch (err) {
		await params.prompter.note(`GitHub Copilot login failed: ${String(err)}`, "GitHub Copilot");
		return { config: nextConfig };
	}
	nextConfig = applyAuthProfileConfig(nextConfig, {
		profileId: "github-copilot:github",
		provider: "github-copilot",
		mode: "token"
	});
	if (params.setDefaultModel) {
		const model = "github-copilot/gpt-4o";
		nextConfig = {
			...nextConfig,
			agents: {
				...nextConfig.agents,
				defaults: {
					...nextConfig.agents?.defaults,
					model: {
						...toAgentModelListLike(nextConfig.agents?.defaults?.model),
						primary: model
					}
				}
			}
		};
		await params.prompter.note(`Default model set to ${model}`, "Model configured");
	}
	return { config: nextConfig };
}

//#endregion
//#region src/commands/auth-choice.apply.google-gemini-cli.ts
async function applyAuthChoiceGoogleGeminiCli(params) {
	if (params.authChoice !== "google-gemini-cli") return null;
	await params.prompter.note([
		"This is an unofficial integration and is not endorsed by Google.",
		"Some users have reported account restrictions or suspensions after using third-party Gemini CLI and Antigravity OAuth clients.",
		"Proceed only if you understand and accept this risk."
	].join("\n"), "Google Gemini CLI caution");
	if (!await params.prompter.confirm({
		message: "Continue with Google Gemini CLI OAuth?",
		initialValue: false
	})) {
		await params.prompter.note("Skipped Google Gemini CLI OAuth setup.", "Setup skipped");
		return { config: params.config };
	}
	return await applyAuthChoicePluginProvider(params, {
		authChoice: "google-gemini-cli",
		pluginId: "google-gemini-cli-auth",
		providerId: "google-gemini-cli",
		methodId: "oauth",
		label: "Google Gemini CLI"
	});
}

//#endregion
//#region src/commands/auth-choice.apply.minimax.ts
async function applyAuthChoiceMiniMax(params) {
	let nextConfig = params.config;
	let agentModelOverride;
	const applyProviderDefaultModel = createAuthChoiceDefaultModelApplier(params, createAuthChoiceModelStateBridge({
		getConfig: () => nextConfig,
		setConfig: (config) => nextConfig = config,
		getAgentModelOverride: () => agentModelOverride,
		setAgentModelOverride: (model) => agentModelOverride = model
	}));
	const requestedSecretInputMode = normalizeSecretInputModeInput(params.opts?.secretInputMode);
	const ensureMinimaxApiKey = async (opts) => {
		await ensureApiKeyFromOptionEnvOrPrompt({
			token: params.opts?.token,
			tokenProvider: params.opts?.tokenProvider,
			secretInputMode: requestedSecretInputMode,
			config: nextConfig,
			expectedProviders: ["minimax", "minimax-cn"],
			provider: "minimax",
			envLabel: "MINIMAX_API_KEY",
			promptMessage: opts.promptMessage,
			normalize: normalizeApiKeyInput,
			validate: validateApiKeyInput,
			prompter: params.prompter,
			setCredential: async (apiKey, mode) => setMinimaxApiKey(apiKey, params.agentDir, opts.profileId, { secretInputMode: mode })
		});
	};
	const applyMinimaxApiVariant = async (opts) => {
		await ensureMinimaxApiKey({
			profileId: opts.profileId,
			promptMessage: opts.promptMessage
		});
		nextConfig = applyAuthProfileConfig(nextConfig, {
			profileId: opts.profileId,
			provider: opts.provider,
			mode: "api_key"
		});
		await applyProviderDefaultModel({
			defaultModel: `${opts.modelRefPrefix}/${opts.modelId}`,
			applyDefaultConfig: (config) => opts.applyDefaultConfig(config, opts.modelId),
			applyProviderConfig: (config) => opts.applyProviderConfig(config, opts.modelId)
		});
		return {
			config: nextConfig,
			agentModelOverride
		};
	};
	if (params.authChoice === "minimax-portal") return await applyAuthChoicePluginProvider(params, {
		authChoice: "minimax-portal",
		pluginId: "minimax-portal-auth",
		providerId: "minimax-portal",
		methodId: await params.prompter.select({
			message: "Select MiniMax endpoint",
			options: [{
				value: "oauth",
				label: "Global",
				hint: "OAuth for international users"
			}, {
				value: "oauth-cn",
				label: "CN",
				hint: "OAuth for users in China"
			}]
		}),
		label: "MiniMax"
	});
	if (params.authChoice === "minimax-cloud" || params.authChoice === "minimax-api" || params.authChoice === "minimax-api-lightning") return await applyMinimaxApiVariant({
		profileId: "minimax:default",
		provider: "minimax",
		promptMessage: "Enter MiniMax API key",
		modelRefPrefix: "minimax",
		modelId: params.authChoice === "minimax-api-lightning" ? "MiniMax-M2.5-Lightning" : "MiniMax-M2.5",
		applyDefaultConfig: applyMinimaxApiConfig,
		applyProviderConfig: applyMinimaxApiProviderConfig
	});
	if (params.authChoice === "minimax-api-key-cn") return await applyMinimaxApiVariant({
		profileId: "minimax-cn:default",
		provider: "minimax-cn",
		promptMessage: "Enter MiniMax China API key",
		modelRefPrefix: "minimax-cn",
		modelId: "MiniMax-M2.5",
		applyDefaultConfig: applyMinimaxApiConfigCn,
		applyProviderConfig: applyMinimaxApiProviderConfigCn
	});
	if (params.authChoice === "minimax") {
		await applyProviderDefaultModel({
			defaultModel: "lmstudio/minimax-m2.1-gs32",
			applyDefaultConfig: applyMinimaxConfig,
			applyProviderConfig: applyMinimaxProviderConfig
		});
		return {
			config: nextConfig,
			agentModelOverride
		};
	}
	return null;
}

//#endregion
//#region src/commands/chutes-oauth.ts
function parseManualOAuthInput(input, expectedState) {
	const trimmed = String(input ?? "").trim();
	if (!trimmed) throw new Error("Missing OAuth redirect URL or authorization code.");
	if (!(/^https?:\/\//i.test(trimmed) || trimmed.includes("://") || trimmed.includes("?"))) return {
		code: trimmed,
		state: expectedState
	};
	const parsed = parseOAuthCallbackInput(trimmed, expectedState);
	if ("error" in parsed) throw new Error(parsed.error);
	if (parsed.state !== expectedState) throw new Error("Invalid OAuth state");
	return parsed;
}
function buildAuthorizeUrl(params) {
	return `${CHUTES_AUTHORIZE_ENDPOINT}?${new URLSearchParams({
		client_id: params.clientId,
		redirect_uri: params.redirectUri,
		response_type: "code",
		scope: params.scopes.join(" "),
		state: params.state,
		code_challenge: params.challenge,
		code_challenge_method: "S256"
	}).toString()}`;
}
async function waitForLocalCallback(params) {
	const redirectUrl = new URL(params.redirectUri);
	if (redirectUrl.protocol !== "http:") throw new Error(`Chutes OAuth redirect URI must be http:// (got ${params.redirectUri})`);
	const hostname = redirectUrl.hostname || "127.0.0.1";
	if (!isLoopbackHost(hostname)) throw new Error(`Chutes OAuth redirect hostname must be loopback (got ${hostname}). Use http://127.0.0.1:<port>/...`);
	const port = redirectUrl.port ? Number.parseInt(redirectUrl.port, 10) : 80;
	const expectedPath = redirectUrl.pathname || "/";
	return await new Promise((resolve, reject) => {
		let timeout = null;
		const server = createServer((req, res) => {
			try {
				const requestUrl = new URL(req.url ?? "/", redirectUrl.origin);
				if (requestUrl.pathname !== expectedPath) {
					res.statusCode = 404;
					res.setHeader("Content-Type", "text/plain; charset=utf-8");
					res.end("Not found");
					return;
				}
				const code = requestUrl.searchParams.get("code")?.trim();
				const state = requestUrl.searchParams.get("state")?.trim();
				if (!code) {
					res.statusCode = 400;
					res.setHeader("Content-Type", "text/plain; charset=utf-8");
					res.end("Missing code");
					return;
				}
				if (!state || state !== params.expectedState) {
					res.statusCode = 400;
					res.setHeader("Content-Type", "text/plain; charset=utf-8");
					res.end("Invalid state");
					return;
				}
				res.statusCode = 200;
				res.setHeader("Content-Type", "text/html; charset=utf-8");
				res.end([
					"<!doctype html>",
					"<html><head><meta charset='utf-8' /></head>",
					"<body><h2>Chutes OAuth complete</h2>",
					"<p>You can close this window and return to OpenClaw.</p></body></html>"
				].join(""));
				if (timeout) clearTimeout(timeout);
				server.close();
				resolve({
					code,
					state
				});
			} catch (err) {
				if (timeout) clearTimeout(timeout);
				server.close();
				reject(err);
			}
		});
		server.once("error", (err) => {
			if (timeout) clearTimeout(timeout);
			server.close();
			reject(err);
		});
		server.listen(port, hostname, () => {
			params.onProgress?.(`Waiting for OAuth callback on ${redirectUrl.origin}${expectedPath}…`);
		});
		timeout = setTimeout(() => {
			try {
				server.close();
			} catch {}
			reject(/* @__PURE__ */ new Error("OAuth callback timeout"));
		}, params.timeoutMs);
	});
}
async function loginChutes(params) {
	const createPkce = params.createPkce ?? generateChutesPkce;
	const createState = params.createState ?? (() => randomBytes(16).toString("hex"));
	const { verifier, challenge } = createPkce();
	const state = createState();
	const timeoutMs = params.timeoutMs ?? 180 * 1e3;
	const url = buildAuthorizeUrl({
		clientId: params.app.clientId,
		redirectUri: params.app.redirectUri,
		scopes: params.app.scopes,
		state,
		challenge
	});
	let codeAndState;
	if (params.manual) {
		await params.onAuth({ url });
		params.onProgress?.("Waiting for redirect URL…");
		codeAndState = parseManualOAuthInput(await params.onPrompt({
			message: "Paste the redirect URL (or authorization code)",
			placeholder: `${params.app.redirectUri}?code=...&state=...`
		}), state);
	} else {
		const callback = waitForLocalCallback({
			redirectUri: params.app.redirectUri,
			expectedState: state,
			timeoutMs,
			onProgress: params.onProgress
		}).catch(async () => {
			params.onProgress?.("OAuth callback not detected; paste redirect URL…");
			return parseManualOAuthInput(await params.onPrompt({
				message: "Paste the redirect URL (or authorization code)",
				placeholder: `${params.app.redirectUri}?code=...&state=...`
			}), state);
		});
		await params.onAuth({ url });
		codeAndState = await callback;
	}
	params.onProgress?.("Exchanging code for tokens…");
	return await exchangeChutesCodeForTokens({
		app: params.app,
		code: codeAndState.code,
		codeVerifier: verifier,
		fetchFn: params.fetchFn
	});
}

//#endregion
//#region src/commands/auth-choice.apply.oauth.ts
async function applyAuthChoiceOAuth(params) {
	if (params.authChoice === "chutes") {
		let nextConfig = params.config;
		const isRemote = isRemoteEnvironment();
		const redirectUri = process.env.CHUTES_OAUTH_REDIRECT_URI?.trim() || "http://127.0.0.1:1456/oauth-callback";
		const scopes = process.env.CHUTES_OAUTH_SCOPES?.trim() || "openid profile chutes:invoke";
		const clientId = process.env.CHUTES_CLIENT_ID?.trim() || String(await params.prompter.text({
			message: "Enter Chutes OAuth client id",
			placeholder: "cid_xxx",
			validate: (value) => value?.trim() ? void 0 : "Required"
		})).trim();
		const clientSecret = process.env.CHUTES_CLIENT_SECRET?.trim() || void 0;
		await params.prompter.note(isRemote ? [
			"You are running in a remote/VPS environment.",
			"A URL will be shown for you to open in your LOCAL browser.",
			"After signing in, paste the redirect URL back here.",
			"",
			`Redirect URI: ${redirectUri}`
		].join("\n") : [
			"Browser will open for Chutes authentication.",
			"If the callback doesn't auto-complete, paste the redirect URL.",
			"",
			`Redirect URI: ${redirectUri}`
		].join("\n"), "Chutes OAuth");
		const spin = params.prompter.progress("Starting OAuth flow…");
		try {
			const { onAuth, onPrompt } = createVpsAwareOAuthHandlers({
				isRemote,
				prompter: params.prompter,
				runtime: params.runtime,
				spin,
				openUrl,
				localBrowserMessage: "Complete sign-in in browser…"
			});
			const creds = await loginChutes({
				app: {
					clientId,
					clientSecret,
					redirectUri,
					scopes: scopes.split(/\s+/).filter(Boolean)
				},
				manual: isRemote,
				onAuth,
				onPrompt,
				onProgress: (msg) => spin.update(msg)
			});
			spin.stop("Chutes OAuth complete");
			const profileId = await writeOAuthCredentials("chutes", creds, params.agentDir);
			nextConfig = applyAuthProfileConfig(nextConfig, {
				profileId,
				provider: "chutes",
				mode: "oauth"
			});
		} catch (err) {
			spin.stop("Chutes OAuth failed");
			params.runtime.error(String(err));
			await params.prompter.note([
				"Trouble with OAuth?",
				"Verify CHUTES_CLIENT_ID (and CHUTES_CLIENT_SECRET if required).",
				`Verify the OAuth app redirect URI includes: ${redirectUri}`,
				"Chutes docs: https://chutes.ai/docs/sign-in-with-chutes/overview"
			].join("\n"), "OAuth help");
		}
		return { config: nextConfig };
	}
	return null;
}

//#endregion
//#region src/commands/openai-codex-oauth.ts
async function loginOpenAICodexOAuth(params) {
	const { prompter, runtime, isRemote, openUrl, localBrowserMessage } = params;
	await prompter.note(isRemote ? [
		"You are running in a remote/VPS environment.",
		"A URL will be shown for you to open in your LOCAL browser.",
		"After signing in, paste the redirect URL back here."
	].join("\n") : [
		"Browser will open for OpenAI authentication.",
		"If the callback doesn't auto-complete, paste the redirect URL.",
		"OpenAI OAuth uses localhost:1455 for the callback."
	].join("\n"), "OpenAI Codex OAuth");
	const spin = prompter.progress("Starting OAuth flow…");
	try {
		const { onAuth, onPrompt } = createVpsAwareOAuthHandlers({
			isRemote,
			prompter,
			runtime,
			spin,
			openUrl,
			localBrowserMessage: localBrowserMessage ?? "Complete sign-in in browser…"
		});
		const creds = await loginOpenAICodex({
			onAuth,
			onPrompt,
			onProgress: (msg) => spin.update(msg)
		});
		spin.stop("OpenAI OAuth complete");
		return creds ?? null;
	} catch (err) {
		spin.stop("OpenAI OAuth failed");
		runtime.error(String(err));
		await prompter.note("Trouble with OAuth? See https://docs.openclaw.ai/start/faq", "OAuth help");
		throw err;
	}
}

//#endregion
//#region src/commands/auth-choice.apply.openai.ts
async function applyAuthChoiceOpenAI(params) {
	const requestedSecretInputMode = normalizeSecretInputModeInput(params.opts?.secretInputMode);
	const noteAgentModel = createAuthChoiceAgentModelNoter(params);
	let authChoice = params.authChoice;
	if (authChoice === "apiKey" && params.opts?.tokenProvider === "openai") authChoice = "openai-api-key";
	if (authChoice === "openai-api-key") {
		let nextConfig = params.config;
		let agentModelOverride;
		const applyOpenAiDefaultModelChoice = async () => {
			const applied = await applyDefaultModelChoice({
				config: nextConfig,
				setDefaultModel: params.setDefaultModel,
				defaultModel: OPENAI_DEFAULT_MODEL,
				applyDefaultConfig: applyOpenAIConfig,
				applyProviderConfig: applyOpenAIProviderConfig,
				noteDefault: OPENAI_DEFAULT_MODEL,
				noteAgentModel,
				prompter: params.prompter
			});
			nextConfig = applied.config;
			agentModelOverride = applied.agentModelOverride ?? agentModelOverride;
			return {
				config: nextConfig,
				agentModelOverride
			};
		};
		await ensureApiKeyFromOptionEnvOrPrompt({
			token: params.opts?.token,
			tokenProvider: params.opts?.tokenProvider,
			secretInputMode: requestedSecretInputMode,
			config: nextConfig,
			expectedProviders: ["openai"],
			provider: "openai",
			envLabel: "OPENAI_API_KEY",
			promptMessage: "Enter OpenAI API key",
			normalize: normalizeApiKeyInput,
			validate: validateApiKeyInput,
			prompter: params.prompter,
			setCredential: async (apiKey, mode) => setOpenaiApiKey(apiKey, params.agentDir, { secretInputMode: mode })
		});
		nextConfig = applyAuthProfileConfig(nextConfig, {
			profileId: "openai:default",
			provider: "openai",
			mode: "api_key"
		});
		return await applyOpenAiDefaultModelChoice();
	}
	if (params.authChoice === "openai-codex") {
		let nextConfig = params.config;
		let agentModelOverride;
		let creds;
		try {
			creds = await loginOpenAICodexOAuth({
				prompter: params.prompter,
				runtime: params.runtime,
				isRemote: isRemoteEnvironment(),
				openUrl: async (url) => {
					await openUrl(url);
				},
				localBrowserMessage: "Complete sign-in in browser…"
			});
		} catch {
			return {
				config: nextConfig,
				agentModelOverride
			};
		}
		if (creds) {
			const profileId = await writeOAuthCredentials("openai-codex", creds, params.agentDir, { syncSiblingAgents: true });
			nextConfig = applyAuthProfileConfig(nextConfig, {
				profileId,
				provider: "openai-codex",
				mode: "oauth"
			});
			if (params.setDefaultModel) {
				const applied = applyOpenAICodexModelDefault(nextConfig);
				nextConfig = applied.next;
				if (applied.changed) await params.prompter.note(`Default model set to ${OPENAI_CODEX_DEFAULT_MODEL}`, "Model configured");
			} else {
				agentModelOverride = OPENAI_CODEX_DEFAULT_MODEL;
				await noteAgentModel(OPENAI_CODEX_DEFAULT_MODEL);
			}
		}
		return {
			config: nextConfig,
			agentModelOverride
		};
	}
	return null;
}

//#endregion
//#region src/commands/auth-choice.apply.qwen-portal.ts
async function applyAuthChoiceQwenPortal(params) {
	return await applyAuthChoicePluginProvider(params, {
		authChoice: "qwen-portal",
		pluginId: "qwen-portal-auth",
		providerId: "qwen-portal",
		methodId: "device",
		label: "Qwen"
	});
}

//#endregion
//#region src/commands/auth-choice.apply.vllm.ts
function applyVllmDefaultModel(cfg, modelRef) {
	const existingModel = cfg.agents?.defaults?.model;
	const fallbacks = existingModel && typeof existingModel === "object" && "fallbacks" in existingModel ? existingModel.fallbacks : void 0;
	return {
		...cfg,
		agents: {
			...cfg.agents,
			defaults: {
				...cfg.agents?.defaults,
				model: {
					...fallbacks ? { fallbacks } : void 0,
					primary: modelRef
				}
			}
		}
	};
}
async function applyAuthChoiceVllm(params) {
	if (params.authChoice !== "vllm") return null;
	const { config: nextConfig, modelRef } = await promptAndConfigureVllm({
		cfg: params.config,
		prompter: params.prompter,
		agentDir: params.agentDir
	});
	if (!params.setDefaultModel) return {
		config: nextConfig,
		agentModelOverride: modelRef
	};
	await params.prompter.note(`Default model set to ${modelRef}`, "Model configured");
	return { config: applyVllmDefaultModel(nextConfig, modelRef) };
}

//#endregion
//#region src/commands/auth-choice.apply.volcengine.ts
/** Default model for Volcano Engine auth onboarding. */
const VOLCENGINE_DEFAULT_MODEL = "volcengine-plan/ark-code-latest";
async function applyAuthChoiceVolcengine(params) {
	if (params.authChoice !== "volcengine-api-key") return null;
	const requestedSecretInputMode = normalizeSecretInputModeInput(params.opts?.secretInputMode);
	await ensureApiKeyFromOptionEnvOrPrompt({
		token: params.opts?.volcengineApiKey,
		tokenProvider: "volcengine",
		secretInputMode: requestedSecretInputMode,
		config: params.config,
		expectedProviders: ["volcengine"],
		provider: "volcengine",
		envLabel: "VOLCANO_ENGINE_API_KEY",
		promptMessage: "Enter Volcano Engine API key",
		normalize: normalizeApiKeyInput,
		validate: validateApiKeyInput,
		prompter: params.prompter,
		setCredential: async (apiKey, mode) => setVolcengineApiKey(apiKey, params.agentDir, { secretInputMode: mode })
	});
	return {
		config: applyPrimaryModel(applyAuthProfileConfig(params.config, {
			profileId: "volcengine:default",
			provider: "volcengine",
			mode: "api_key"
		}), VOLCENGINE_DEFAULT_MODEL),
		agentModelOverride: VOLCENGINE_DEFAULT_MODEL
	};
}

//#endregion
//#region src/commands/auth-choice.apply.xai.ts
async function applyAuthChoiceXAI(params) {
	if (params.authChoice !== "xai-api-key") return null;
	let nextConfig = params.config;
	let agentModelOverride;
	const noteAgentModel = createAuthChoiceAgentModelNoter(params);
	const requestedSecretInputMode = normalizeSecretInputModeInput(params.opts?.secretInputMode);
	await ensureApiKeyFromOptionEnvOrPrompt({
		token: params.opts?.xaiApiKey,
		tokenProvider: "xai",
		secretInputMode: requestedSecretInputMode,
		config: nextConfig,
		expectedProviders: ["xai"],
		provider: "xai",
		envLabel: "XAI_API_KEY",
		promptMessage: "Enter xAI API key",
		normalize: normalizeApiKeyInput,
		validate: validateApiKeyInput,
		prompter: params.prompter,
		setCredential: async (apiKey, mode) => setXaiApiKey(apiKey, params.agentDir, { secretInputMode: mode })
	});
	nextConfig = applyAuthProfileConfig(nextConfig, {
		profileId: "xai:default",
		provider: "xai",
		mode: "api_key"
	});
	{
		const applied = await applyDefaultModelChoice({
			config: nextConfig,
			setDefaultModel: params.setDefaultModel,
			defaultModel: XAI_DEFAULT_MODEL_REF,
			applyDefaultConfig: applyXaiConfig,
			applyProviderConfig: applyXaiProviderConfig,
			noteDefault: XAI_DEFAULT_MODEL_REF,
			noteAgentModel,
			prompter: params.prompter
		});
		nextConfig = applied.config;
		agentModelOverride = applied.agentModelOverride ?? agentModelOverride;
	}
	return {
		config: nextConfig,
		agentModelOverride
	};
}

//#endregion
//#region src/commands/auth-choice.apply.ts
async function applyAuthChoice(params) {
	const handlers = [
		applyAuthChoiceAnthropic,
		applyAuthChoiceVllm,
		applyAuthChoiceOpenAI,
		applyAuthChoiceOAuth,
		applyAuthChoiceApiProviders,
		applyAuthChoiceMiniMax,
		applyAuthChoiceGitHubCopilot,
		applyAuthChoiceGoogleGeminiCli,
		applyAuthChoiceCopilotProxy,
		applyAuthChoiceQwenPortal,
		applyAuthChoiceXAI,
		applyAuthChoiceVolcengine,
		applyAuthChoiceBytePlus
	];
	for (const handler of handlers) {
		const result = await handler(params);
		if (result) return result;
	}
	return { config: params.config };
}

//#endregion
//#region src/commands/auth-choice.model-check.ts
async function warnIfModelConfigLooksOff(config, prompter, options) {
	const ref = resolveDefaultModelForAgent({
		cfg: config,
		agentId: options?.agentId
	});
	const warnings = [];
	const catalog = await loadModelCatalog({
		config,
		useCache: false
	});
	if (catalog.length > 0) {
		if (!catalog.some((entry) => entry.provider === ref.provider && entry.id === ref.model)) warnings.push(`Model not found: ${ref.provider}/${ref.model}. Update agents.defaults.model or run /models list.`);
	}
	const store = ensureAuthProfileStore(options?.agentDir);
	const hasProfile = listProfilesForProvider(store, ref.provider).length > 0;
	const envKey = resolveEnvApiKey(ref.provider);
	const customKey = getCustomProviderApiKey(config, ref.provider);
	if (!hasProfile && !envKey && !customKey) warnings.push(`No auth configured for provider "${ref.provider}". The agent may fail until credentials are added.`);
	if (ref.provider === "openai") {
		if (listProfilesForProvider(store, "openai-codex").length > 0) warnings.push(`Detected OpenAI Codex OAuth. Consider setting agents.defaults.model to ${OPENAI_CODEX_DEFAULT_MODEL}.`);
	}
	if (warnings.length > 0) await prompter.note(warnings.join("\n"), "Model check");
}

//#endregion
//#region src/commands/auth-choice.preferred-provider.ts
const PREFERRED_PROVIDER_BY_AUTH_CHOICE = {
	oauth: "anthropic",
	"setup-token": "anthropic",
	"claude-cli": "anthropic",
	token: "anthropic",
	apiKey: "anthropic",
	vllm: "vllm",
	"openai-codex": "openai-codex",
	"codex-cli": "openai-codex",
	chutes: "chutes",
	"openai-api-key": "openai",
	"openrouter-api-key": "openrouter",
	"kilocode-api-key": "kilocode",
	"ai-gateway-api-key": "vercel-ai-gateway",
	"cloudflare-ai-gateway-api-key": "cloudflare-ai-gateway",
	"moonshot-api-key": "moonshot",
	"moonshot-api-key-cn": "moonshot",
	"kimi-code-api-key": "kimi-coding",
	"gemini-api-key": "google",
	"google-gemini-cli": "google-gemini-cli",
	"mistral-api-key": "mistral",
	"zai-api-key": "zai",
	"zai-coding-global": "zai",
	"zai-coding-cn": "zai",
	"zai-global": "zai",
	"zai-cn": "zai",
	"xiaomi-api-key": "xiaomi",
	"synthetic-api-key": "synthetic",
	"venice-api-key": "venice",
	"together-api-key": "together",
	"huggingface-api-key": "huggingface",
	"github-copilot": "github-copilot",
	"copilot-proxy": "copilot-proxy",
	"minimax-cloud": "minimax",
	"minimax-api": "minimax",
	"minimax-api-key-cn": "minimax-cn",
	"minimax-api-lightning": "minimax",
	minimax: "lmstudio",
	"opencode-zen": "opencode",
	"xai-api-key": "xai",
	"litellm-api-key": "litellm",
	"qwen-portal": "qwen-portal",
	"volcengine-api-key": "volcengine",
	"byteplus-api-key": "byteplus",
	"minimax-portal": "minimax-portal",
	"qianfan-api-key": "qianfan",
	"custom-api-key": "custom"
};
function resolvePreferredProviderForAuthChoice(choice) {
	return PREFERRED_PROVIDER_BY_AUTH_CHOICE[choice];
}

//#endregion
//#region src/commands/auth-choice.ts
var auth_choice_exports = /* @__PURE__ */ __exportAll({
	applyAuthChoice: () => applyAuthChoice,
	resolvePreferredProviderForAuthChoice: () => resolvePreferredProviderForAuthChoice,
	warnIfModelConfigLooksOff: () => warnIfModelConfigLooksOff
});

//#endregion
export { applyAuthChoice as i, resolvePreferredProviderForAuthChoice as n, warnIfModelConfigLooksOff as r, auth_choice_exports as t };