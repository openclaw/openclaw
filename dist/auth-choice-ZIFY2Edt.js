import { t as __exportAll } from "./rolldown-runtime-DUslC3ob.js";
import { $f as isHuggingfacePolicyLocked, Av as upsertAuthProfile, Df as resolveEnvApiKey, Et as openUrl, F as resolveDefaultModelForAgent, Hf as SYNTHETIC_DEFAULT_MODEL_REF, Kf as VENICE_DEFAULT_MODEL_REF, Ov as listProfilesForProvider, Qf as discoverHuggingfaceModels, Qg as parseOAuthCallbackInput, Xg as exchangeChutesCodeForTokens, Yg as CHUTES_AUTHORIZE_ENDPOINT, Zg as generateChutesPkce, ap as CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF, bf as loadModelCatalog, ip as KILOCODE_DEFAULT_MODEL_REF, jv as ensureAuthProfileStore, lp as resolveAuthProfileOrder, sg as isLoopbackHost, wf as hasUsableCustomProviderApiKey } from "./reply-kqyKJg4x.js";
import { F as toAgentModelListLike } from "./agent-scope-BwZuo7sQ.js";
import { a as normalizeSecretInputModeInput, c as resolveSecretInputModeForEnvSelection, d as normalizeApiKeyInput, f as validateApiKeyInput, i as ensureApiKeyFromOptionEnvOrPrompt, l as applyDefaultModelChoice, n as createAuthChoiceDefaultModelApplierForMutableState, o as normalizeTokenProviderInput, s as promptSecretRefForOnboarding, t as createAuthChoiceAgentModelNoter, u as ensureModelAllowlistEntry } from "./auth-choice.apply-helpers-BWcTlSML.js";
import { $ as applyLitellmProviderConfig, A as applyModelStudioProviderConfig, At as setTogetherApiKey, B as applySyntheticConfig, Bt as MODELSTUDIO_DEFAULT_MODEL_REF, C as applyKilocodeProviderConfig, Ct as setMoonshotApiKey, D as applyMistralProviderConfig, Dt as setOpenrouterApiKey, E as applyMistralConfig, Et as setOpencodeZenApiKey, F as applyMoonshotProviderConfigCn, Ft as setXiaomiApiKey, G as applyVeniceProviderConfig, H as applyTogetherConfig, Ht as QIANFAN_DEFAULT_MODEL_REF, I as applyOpenrouterConfig, It as setZaiApiKey, J as applyXiaomiConfig, K as applyXaiConfig, L as applyOpenrouterProviderConfig, Lt as writeOAuthCredentials, M as applyMoonshotConfig, Mt as setVercelAiGatewayApiKey, N as applyMoonshotConfigCn, Nt as setVolcengineApiKey, O as applyModelStudioConfig, Ot as setQianfanApiKey, P as applyMoonshotProviderConfig, Pt as setXaiApiKey, Q as applyLitellmConfig, R as applyQianfanConfig, Rt as KIMI_CODING_MODEL_REF, S as applyKilocodeConfig, St as setModelStudioApiKey, T as applyKimiCodeProviderConfig, Tt as setOpencodeGoApiKey, U as applyTogetherProviderConfig, Ut as XAI_DEFAULT_MODEL_REF, V as applySyntheticProviderConfig, Vt as MOONSHOT_DEFAULT_MODEL_REF, W as applyVeniceConfig, X as applyZaiConfig, Y as applyXiaomiProviderConfig, Z as applyZaiProviderConfig, _ as applyMinimaxApiProviderConfig, _t as setKilocodeApiKey, a as OPENAI_CODEX_DEFAULT_MODEL, at as HUGGINGFACE_DEFAULT_MODEL_REF, bt as setMinimaxApiKey, c as isRemoteEnvironment, ct as TOGETHER_DEFAULT_MODEL_REF, d as OPENCODE_GO_DEFAULT_MODEL_REF, dt as ZAI_DEFAULT_MODEL_REF, et as applyCloudflareAiGatewayConfig, ft as setAnthropicApiKey, g as applyMinimaxApiConfigCn, gt as setHuggingfaceApiKey, h as applyMinimaxApiConfig, ht as setGeminiApiKey, it as applyAgentDefaultModelPrimary, j as applyModelStudioProviderConfigCn, jt as setVeniceApiKey, k as applyModelStudioConfigCn, kt as setSyntheticApiKey, l as applyOpencodeGoConfig, lt as VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF, m as applyOpencodeZenProviderConfig, mt as setCloudflareAiGatewayConfig, nt as applyVercelAiGatewayConfig, o as applyOpenAICodexModelDefault, ot as LITELLM_DEFAULT_MODEL_REF, p as applyOpencodeZenConfig, pt as setByteplusApiKey, q as applyXaiProviderConfig, rt as applyVercelAiGatewayProviderConfig, s as createVpsAwareOAuthHandlers, st as OPENROUTER_DEFAULT_MODEL_REF, tt as applyCloudflareAiGatewayProviderConfig, u as applyOpencodeGoProviderConfig, ut as XIAOMI_DEFAULT_MODEL_REF, v as applyMinimaxApiProviderConfigCn, vt as setKimiCodingApiKey, w as applyKimiCodeConfig, wt as setOpenaiApiKey, x as applyHuggingfaceProviderConfig, xt as setMistralApiKey, y as applyAuthProfileConfig, yt as setLitellmApiKey, z as applyQianfanProviderConfig, zt as MISTRAL_DEFAULT_MODEL_REF } from "./provider-auth-helpers-ZFf3jF1w.js";
import { n as githubCopilotLoginCommand, t as loginOpenAICodexOAuth } from "./openai-codex-oauth-BYNTgZv5.js";
import { n as validateAnthropicSetupToken, t as buildTokenProfileId } from "./auth-token-B-zVa-6k.js";
import { a as detectZaiEndpoint, i as applyOpenAIProviderConfig, n as OPENAI_DEFAULT_MODEL, o as GOOGLE_GEMINI_DEFAULT_MODEL, r as applyOpenAIConfig, s as applyGoogleGeminiModelDefault, t as resolvePreferredProviderForAuthChoice } from "./auth-choice.preferred-provider-CBGPUenr.js";
import { c as applyAuthChoicePluginProvider, r as applyPrimaryModel, s as applyAuthChoiceLoadedPluginProvider } from "./model-picker-Cw_eH3G_.js";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
//#region src/commands/auth-choice.apply.anthropic.ts
const DEFAULT_ANTHROPIC_MODEL = "anthropic/claude-sonnet-4-6";
async function applyAuthChoiceAnthropic(params) {
	const requestedSecretInputMode = normalizeSecretInputModeInput(params.opts?.secretInputMode);
	if (params.authChoice === "setup-token" || params.authChoice === "oauth" || params.authChoice === "token") {
		let nextConfig = params.config;
		await params.prompter.note(["Run `claude setup-token` in your terminal.", "Then paste the generated token below."].join("\n"), "Anthropic setup-token");
		const selectedMode = await resolveSecretInputModeForEnvSelection({
			prompter: params.prompter,
			explicitMode: requestedSecretInputMode,
			copy: {
				modeMessage: "How do you want to provide this setup token?",
				plaintextLabel: "Paste setup token now",
				plaintextHint: "Stores the token directly in the auth profile"
			}
		});
		let token = "";
		let tokenRef;
		if (selectedMode === "ref") {
			const resolved = await promptSecretRefForOnboarding({
				provider: "anthropic-setup-token",
				config: params.config,
				prompter: params.prompter,
				preferredEnvVar: "ANTHROPIC_SETUP_TOKEN",
				copy: {
					sourceMessage: "Where is this Anthropic setup token stored?",
					envVarPlaceholder: "ANTHROPIC_SETUP_TOKEN"
				}
			});
			token = resolved.resolvedValue.trim();
			tokenRef = resolved.ref;
		} else {
			const tokenRaw = await params.prompter.text({
				message: "Paste Anthropic setup-token",
				validate: (value) => validateAnthropicSetupToken(String(value ?? ""))
			});
			token = String(tokenRaw ?? "").trim();
		}
		const tokenValidationError = validateAnthropicSetupToken(token);
		if (tokenValidationError) throw new Error(tokenValidationError);
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
				token,
				...tokenRef ? { tokenRef } : {}
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
//#region src/commands/opencode-zen-model-default.ts
const OPENCODE_ZEN_DEFAULT_MODEL = "opencode/claude-opus-4-6";
//#endregion
//#region src/commands/auth-choice.apply.api-key-providers.ts
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
		expectedProviders: ["opencode", "opencode-go"],
		envLabel: "OPENCODE_API_KEY",
		promptMessage: "Enter OpenCode API key",
		setCredential: setOpencodeZenApiKey,
		defaultModel: OPENCODE_ZEN_DEFAULT_MODEL,
		applyDefaultConfig: applyOpencodeZenConfig,
		applyProviderConfig: applyOpencodeZenProviderConfig,
		noteDefault: OPENCODE_ZEN_DEFAULT_MODEL,
		noteMessage: [
			"OpenCode uses one API key across the Zen and Go catalogs.",
			"Zen provides access to Claude, GPT, Gemini, and more models.",
			"Get your API key at: https://opencode.ai/auth",
			"Choose the Zen catalog when you want the curated multi-model proxy."
		].join("\n"),
		noteTitle: "OpenCode"
	},
	"opencode-go": {
		provider: "opencode-go",
		profileId: "opencode-go:default",
		expectedProviders: ["opencode", "opencode-go"],
		envLabel: "OPENCODE_API_KEY",
		promptMessage: "Enter OpenCode API key",
		setCredential: setOpencodeGoApiKey,
		defaultModel: OPENCODE_GO_DEFAULT_MODEL_REF,
		applyDefaultConfig: applyOpencodeGoConfig,
		applyProviderConfig: applyOpencodeGoProviderConfig,
		noteDefault: OPENCODE_GO_DEFAULT_MODEL_REF,
		noteMessage: [
			"OpenCode uses one API key across the Zen and Go catalogs.",
			"Go provides access to Kimi, GLM, and MiniMax models through the Go catalog.",
			"Get your API key at: https://opencode.ai/auth",
			"Choose the Go catalog when you want the OpenCode-hosted Kimi/GLM/MiniMax lineup."
		].join("\n"),
		noteTitle: "OpenCode"
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
	"modelstudio-api-key-cn": {
		provider: "modelstudio",
		profileId: "modelstudio:default",
		expectedProviders: ["modelstudio"],
		envLabel: "MODELSTUDIO_API_KEY",
		promptMessage: "Enter Alibaba Cloud Model Studio Coding Plan API key (China)",
		setCredential: setModelStudioApiKey,
		defaultModel: MODELSTUDIO_DEFAULT_MODEL_REF,
		applyDefaultConfig: applyModelStudioConfigCn,
		applyProviderConfig: applyModelStudioProviderConfigCn,
		noteDefault: MODELSTUDIO_DEFAULT_MODEL_REF,
		noteMessage: [
			"Get your API key at: https://bailian.console.aliyun.com/",
			"Endpoint: coding.dashscope.aliyuncs.com",
			"Models: qwen3.5-plus, glm-4.7, kimi-k2.5, MiniMax-M2.5, etc."
		].join("\n"),
		noteTitle: "Alibaba Cloud Model Studio Coding Plan (China)",
		normalize: (value) => String(value ?? "").trim(),
		validate: (value) => String(value ?? "").trim() ? void 0 : "Required"
	},
	"modelstudio-api-key": {
		provider: "modelstudio",
		profileId: "modelstudio:default",
		expectedProviders: ["modelstudio"],
		envLabel: "MODELSTUDIO_API_KEY",
		promptMessage: "Enter Alibaba Cloud Model Studio Coding Plan API key (Global/Intl)",
		setCredential: setModelStudioApiKey,
		defaultModel: MODELSTUDIO_DEFAULT_MODEL_REF,
		applyDefaultConfig: applyModelStudioConfig,
		applyProviderConfig: applyModelStudioProviderConfig,
		noteDefault: MODELSTUDIO_DEFAULT_MODEL_REF,
		noteMessage: [
			"Get your API key at: https://bailian.console.aliyun.com/",
			"Endpoint: coding-intl.dashscope.aliyuncs.com",
			"Models: qwen3.5-plus, glm-4.7, kimi-k2.5, MiniMax-M2.5, etc."
		].join("\n"),
		noteTitle: "Alibaba Cloud Model Studio Coding Plan (Global/Intl)",
		normalize: (value) => String(value ?? "").trim(),
		validate: (value) => String(value ?? "").trim() ? void 0 : "Required"
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
async function applyApiKeyProviderWithDefaultModel({ params, config, setConfig, getConfig, normalizedTokenProvider, requestedSecretInputMode, applyProviderDefaultModel, getAgentModelOverride, provider, profileId, expectedProviders, envLabel, promptMessage, setCredential, defaultModel, applyDefaultConfig, applyProviderConfig, noteMessage, noteTitle, tokenProvider = normalizedTokenProvider, normalize = normalizeApiKeyInput, validate = validateApiKeyInput, noteDefault = defaultModel }) {
	let nextConfig = config;
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
	setConfig(nextConfig);
	await applyProviderDefaultModel({
		defaultModel,
		applyDefaultConfig,
		applyProviderConfig,
		noteDefault
	});
	return {
		config: getConfig(),
		agentModelOverride: getAgentModelOverride()
	};
}
async function applyLiteLlmApiKeyProvider({ params, authChoice, config, setConfig, getConfig, normalizedTokenProvider, requestedSecretInputMode, applyProviderDefaultModel, getAgentModelOverride }) {
	if (authChoice !== "litellm-api-key") return null;
	let nextConfig = config;
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
	setConfig(nextConfig);
	await applyProviderDefaultModel({
		defaultModel: LITELLM_DEFAULT_MODEL_REF,
		applyDefaultConfig: applyLitellmConfig,
		applyProviderConfig: applyLitellmProviderConfig,
		noteDefault: LITELLM_DEFAULT_MODEL_REF
	});
	return {
		config: getConfig(),
		agentModelOverride: getAgentModelOverride()
	};
}
async function applySimpleAuthChoiceApiProvider({ params, authChoice, config, setConfig, getConfig, normalizedTokenProvider, requestedSecretInputMode, applyProviderDefaultModel, getAgentModelOverride }) {
	const simpleApiKeyProviderFlow = SIMPLE_API_KEY_PROVIDER_FLOWS[authChoice];
	if (!simpleApiKeyProviderFlow) return null;
	return await applyApiKeyProviderWithDefaultModel({
		params,
		authChoice,
		config,
		setConfig,
		getConfig,
		normalizedTokenProvider,
		requestedSecretInputMode,
		applyProviderDefaultModel,
		getAgentModelOverride,
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
	"opencode-go": "opencode-go",
	kilocode: "kilocode-api-key",
	qianfan: "qianfan-api-key"
};
const ZAI_AUTH_CHOICE_ENDPOINT = {
	"zai-coding-global": "coding-global",
	"zai-coding-cn": "coding-cn",
	"zai-global": "global",
	"zai-cn": "cn"
};
async function applyAuthChoiceApiProviders(params) {
	let nextConfig = params.config;
	let agentModelOverride;
	const noteAgentModel = createAuthChoiceAgentModelNoter(params);
	const applyProviderDefaultModel = createAuthChoiceDefaultModelApplierForMutableState(params, () => nextConfig, (config) => nextConfig = config, () => agentModelOverride, (model) => agentModelOverride = model);
	let authChoice = params.authChoice;
	const normalizedTokenProvider = normalizeTokenProviderInput(params.opts?.tokenProvider);
	const requestedSecretInputMode = normalizeSecretInputModeInput(params.opts?.secretInputMode);
	if (authChoice === "apiKey" && params.opts?.tokenProvider) {
		if (normalizedTokenProvider !== "anthropic" && normalizedTokenProvider !== "openai") authChoice = API_KEY_TOKEN_PROVIDER_AUTH_CHOICE[normalizedTokenProvider ?? ""] ?? authChoice;
	}
	if (authChoice === "openrouter-api-key") return applyAuthChoiceOpenRouter(params);
	const litellmResult = await applyLiteLlmApiKeyProvider({
		params,
		authChoice,
		config: nextConfig,
		setConfig: (config) => nextConfig = config,
		getConfig: () => nextConfig,
		normalizedTokenProvider,
		requestedSecretInputMode,
		applyProviderDefaultModel,
		getAgentModelOverride: () => agentModelOverride
	});
	if (litellmResult) return litellmResult;
	const simpleProviderResult = await applySimpleAuthChoiceApiProvider({
		params,
		authChoice,
		config: nextConfig,
		setConfig: (config) => nextConfig = config,
		getConfig: () => nextConfig,
		normalizedTokenProvider,
		requestedSecretInputMode,
		applyProviderDefaultModel,
		getAgentModelOverride: () => agentModelOverride
	});
	if (simpleProviderResult) return simpleProviderResult;
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
	if (params.authChoice === "minimax-global-oauth") return await applyAuthChoicePluginProvider(params, {
		authChoice: "minimax-global-oauth",
		pluginId: "minimax-portal-auth",
		providerId: "minimax-portal",
		methodId: "oauth",
		label: "MiniMax"
	});
	if (params.authChoice === "minimax-cn-oauth") return await applyAuthChoicePluginProvider(params, {
		authChoice: "minimax-cn-oauth",
		pluginId: "minimax-portal-auth",
		providerId: "minimax-portal",
		methodId: "oauth-cn",
		label: "MiniMax CN"
	});
	if (params.authChoice === "minimax-global-api" || params.authChoice === "minimax-cn-api") {
		const isCn = params.authChoice === "minimax-cn-api";
		const profileId = isCn ? "minimax:cn" : "minimax:global";
		const promptMessage = `Enter MiniMax ${isCn ? "CN " : ""}API key (sk-api- or sk-cp-)\n${isCn ? "https://platform.minimaxi.com/user-center/basic-information/interface-key" : "https://platform.minimax.io/user-center/basic-information/interface-key"}`;
		let nextConfig = params.config;
		let agentModelOverride;
		const applyProviderDefaultModel = createAuthChoiceDefaultModelApplierForMutableState(params, () => nextConfig, (config) => nextConfig = config, () => agentModelOverride, (model) => agentModelOverride = model);
		const requestedSecretInputMode = normalizeSecretInputModeInput(params.opts?.secretInputMode);
		const otherProfileId = isCn ? "minimax:global" : "minimax:cn";
		const noteMessage = Boolean(nextConfig.auth?.profiles?.[otherProfileId]) ? `Note: Global and CN both use the "minimax" provider entry. Saving this key will overwrite the existing ${isCn ? "Global" : "CN"} endpoint (${otherProfileId}).` : void 0;
		await ensureApiKeyFromOptionEnvOrPrompt({
			token: params.opts?.token,
			tokenProvider: params.opts?.tokenProvider,
			secretInputMode: requestedSecretInputMode,
			config: nextConfig,
			expectedProviders: isCn ? ["minimax", "minimax-cn"] : ["minimax"],
			provider: "minimax",
			envLabel: "MINIMAX_API_KEY",
			promptMessage,
			normalize: normalizeApiKeyInput,
			validate: validateApiKeyInput,
			prompter: params.prompter,
			noteMessage,
			setCredential: async (apiKey, mode) => setMinimaxApiKey(apiKey, params.agentDir, profileId, { secretInputMode: mode })
		});
		nextConfig = applyAuthProfileConfig(nextConfig, {
			profileId,
			provider: "minimax",
			mode: "api_key"
		});
		await applyProviderDefaultModel({
			defaultModel: "minimax/MiniMax-M2.5",
			applyDefaultConfig: (config) => isCn ? applyMinimaxApiConfigCn(config) : applyMinimaxApiConfig(config),
			applyProviderConfig: (config) => isCn ? applyMinimaxApiProviderConfigCn(config) : applyMinimaxApiProviderConfig(config)
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
		applyAuthChoiceLoadedPluginProvider,
		applyAuthChoiceAnthropic,
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
	const hasCustomKey = hasUsableCustomProviderApiKey(config, ref.provider);
	if (!hasProfile && !envKey && !hasCustomKey) warnings.push(`No auth configured for provider "${ref.provider}". The agent may fail until credentials are added.`);
	if (ref.provider === "openai") {
		if (listProfilesForProvider(store, "openai-codex").length > 0) warnings.push(`Detected OpenAI Codex OAuth. Consider setting agents.defaults.model to ${OPENAI_CODEX_DEFAULT_MODEL}.`);
	}
	if (warnings.length > 0) await prompter.note(warnings.join("\n"), "Model check");
}
//#endregion
//#region src/commands/auth-choice.ts
var auth_choice_exports = /* @__PURE__ */ __exportAll({
	applyAuthChoice: () => applyAuthChoice,
	resolvePreferredProviderForAuthChoice: () => resolvePreferredProviderForAuthChoice,
	warnIfModelConfigLooksOff: () => warnIfModelConfigLooksOff
});
//#endregion
export { warnIfModelConfigLooksOff as n, applyAuthChoice as r, auth_choice_exports as t };
