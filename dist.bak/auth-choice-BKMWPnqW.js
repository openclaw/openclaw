import { Q as resolveDefaultSecretProviderAlias, Ur as normalizeOptionalSecretInput, Vn as normalizeProviderId, Wr as normalizeSecretInput, _n as upsertAuthProfile, bn as ensureAuthProfileStore, kr as resolveEnvApiKey, l as resolveApiKeyForProfile, n as resolveAuthProfileOrder, rt as parseDurationMs } from "./auth-profiles-D6H-HVV8.js";
import "./agent-scope-C2k6BQnt.js";
import "./openclaw-root-C9tYgTzw.js";
import "./exec-BhaMholX.js";
import "./github-copilot-token-DKRiM6oj.js";
import "./host-env-security-BM8ktVlo.js";
import "./env-vars-DPtuUD7z.js";
import "./manifest-registry-HLdbjiS7.js";
import "./models-config-Cm28W4wc.js";
import "./model-catalog-Def_bWVq.js";
import "./shared-BR_F1Bso.js";
import { A as applyTogetherConfig, B as applyLitellmConfig, E as applyQianfanConfig, H as applyCloudflareAiGatewayConfig, I as applyXiaomiConfig, M as applyVeniceConfig, O as applySyntheticConfig, P as applyXaiConfig, R as applyZaiConfig, St as setZaiApiKey, W as applyVercelAiGatewayConfig, _t as setVeniceApiKey, a as applyMinimaxApiConfig, at as setKilocodeApiKey, b as applyMoonshotConfig, bt as setXaiApiKey, ct as setMinimaxApiKey, d as applyAuthProfileConfig, dt as setOpenaiApiKey, et as setAnthropicApiKey, f as applyHuggingfaceConfig, ft as setOpencodeZenApiKey, g as applyKimiCodeConfig, gt as setTogetherApiKey, ht as setSyntheticApiKey, it as setHuggingfaceApiKey, l as applyMinimaxConfig, lt as setMistralApiKey, m as applyKilocodeConfig, mt as setQianfanApiKey, n as validateAnthropicSetupToken, nt as setCloudflareAiGatewayConfig, o as applyMinimaxApiConfigCn, ot as setKimiCodingApiKey, pt as setOpenrouterApiKey, r as applyOpencodeZenConfig, rt as setGeminiApiKey, st as setLitellmApiKey, t as buildTokenProfileId, tt as setByteplusApiKey, ut as setMoonshotApiKey, v as applyMistralConfig, vt as setVercelAiGatewayApiKey, w as applyOpenrouterConfig, x as applyMoonshotConfigCn, xt as setXiaomiApiKey, yt as setVolcengineApiKey } from "./auth-token-1wFUIrL0.js";
import { o as normalizeSecretInputModeInput } from "./auth-choice.apply-helpers-Z8eSUe5X.js";
import { i as detectZaiEndpoint, n as applyOpenAIConfig, o as applyGoogleGeminiModelDefault } from "./openai-model-default-DcZfcBEx.js";
import { r as applyPrimaryModel } from "./model-picker-Bj_Lb5H7.js";
import { i as parseNonInteractiveCustomApiFlags, n as applyCustomApiConfig, o as resolveCustomProviderId, t as CustomApiError } from "./onboard-custom-B7ZaZ7ch.js";

//#region src/commands/onboard-non-interactive/api-keys.ts
function parseEnvVarNameFromSourceLabel(source) {
	if (!source) return;
	return /^(?:shell env: |env: )([A-Z][A-Z0-9_]*)$/.exec(source.trim())?.[1];
}
async function resolveApiKeyFromProfiles(params) {
	const store = ensureAuthProfileStore(params.agentDir);
	const order = resolveAuthProfileOrder({
		cfg: params.cfg,
		store,
		provider: params.provider
	});
	for (const profileId of order) {
		if (store.profiles[profileId]?.type !== "api_key") continue;
		const resolved = await resolveApiKeyForProfile({
			cfg: params.cfg,
			store,
			profileId,
			agentDir: params.agentDir
		});
		if (resolved?.apiKey) return resolved.apiKey;
	}
	return null;
}
async function resolveNonInteractiveApiKey(params) {
	const flagKey = normalizeOptionalSecretInput(params.flagValue);
	const envResolved = resolveEnvApiKey(params.provider);
	const explicitEnvVar = params.envVarName?.trim();
	const explicitEnvKey = explicitEnvVar ? normalizeOptionalSecretInput(process.env[explicitEnvVar]) : void 0;
	const resolvedEnvKey = envResolved?.apiKey ?? explicitEnvKey;
	const resolvedEnvVarName = parseEnvVarNameFromSourceLabel(envResolved?.source) ?? explicitEnvVar;
	if (params.secretInputMode === "ref") {
		if (!resolvedEnvKey && flagKey) {
			params.runtime.error([`${params.flagName} cannot be used with --secret-input-mode ref unless ${params.envVar} is set in env.`, `Set ${params.envVar} in env and omit ${params.flagName}, or use --secret-input-mode plaintext.`].join("\n"));
			params.runtime.exit(1);
			return null;
		}
		if (resolvedEnvKey) {
			if (!resolvedEnvVarName) {
				params.runtime.error([`--secret-input-mode ref requires an explicit environment variable for provider "${params.provider}".`, `Set ${params.envVar} in env and retry, or use --secret-input-mode plaintext.`].join("\n"));
				params.runtime.exit(1);
				return null;
			}
			return {
				key: resolvedEnvKey,
				source: "env",
				envVarName: resolvedEnvVarName
			};
		}
	}
	if (flagKey) return {
		key: flagKey,
		source: "flag"
	};
	if (resolvedEnvKey) return {
		key: resolvedEnvKey,
		source: "env",
		envVarName: resolvedEnvVarName
	};
	if (params.allowProfile ?? true) {
		const profileKey = await resolveApiKeyFromProfiles({
			provider: params.provider,
			cfg: params.cfg,
			agentDir: params.agentDir
		});
		if (profileKey) return {
			key: profileKey,
			source: "profile"
		};
	}
	if (params.required === false) return null;
	const profileHint = params.allowProfile === false ? "" : `, or existing ${params.provider} API-key profile`;
	params.runtime.error(`Missing ${params.flagName} (or ${params.envVar} in env${profileHint}).`);
	params.runtime.exit(1);
	return null;
}

//#endregion
//#region src/commands/onboard-non-interactive/local/auth-choice.ts
async function applyNonInteractiveAuthChoice(params) {
	const { authChoice, opts, runtime, baseConfig } = params;
	let nextConfig = params.nextConfig;
	const requestedSecretInputMode = normalizeSecretInputModeInput(opts.secretInputMode);
	if (opts.secretInputMode && !requestedSecretInputMode) {
		runtime.error("Invalid --secret-input-mode. Use \"plaintext\" or \"ref\".");
		runtime.exit(1);
		return null;
	}
	const apiKeyStorageOptions = requestedSecretInputMode ? { secretInputMode: requestedSecretInputMode } : void 0;
	const toStoredSecretInput = (resolved) => {
		if (requestedSecretInputMode !== "ref") return resolved.key;
		if (resolved.source !== "env") return resolved.key;
		if (!resolved.envVarName) {
			runtime.error([`Unable to determine which environment variable to store as a ref for provider "${authChoice}".`, "Set an explicit provider env var and retry, or use --secret-input-mode plaintext."].join("\n"));
			runtime.exit(1);
			return null;
		}
		return {
			source: "env",
			provider: resolveDefaultSecretProviderAlias(baseConfig, "env", { preferFirstProviderForSource: true }),
			id: resolved.envVarName
		};
	};
	const resolveApiKey = (input) => resolveNonInteractiveApiKey({
		...input,
		secretInputMode: requestedSecretInputMode
	});
	const maybeSetResolvedApiKey = async (resolved, setter) => {
		if (resolved.source === "profile") return true;
		const stored = toStoredSecretInput(resolved);
		if (!stored) return false;
		await setter(stored);
		return true;
	};
	if (authChoice === "claude-cli" || authChoice === "codex-cli") {
		runtime.error([`Auth choice "${authChoice}" is deprecated.`, "Use \"--auth-choice token\" (Anthropic setup-token) or \"--auth-choice openai-codex\"."].join("\n"));
		runtime.exit(1);
		return null;
	}
	if (authChoice === "setup-token") {
		runtime.error(["Auth choice \"setup-token\" requires interactive mode.", "Use \"--auth-choice token\" with --token and --token-provider anthropic."].join("\n"));
		runtime.exit(1);
		return null;
	}
	if (authChoice === "vllm") {
		runtime.error(["Auth choice \"vllm\" requires interactive mode.", "Use interactive onboard/configure to enter base URL, API key, and model ID."].join("\n"));
		runtime.exit(1);
		return null;
	}
	if (authChoice === "apiKey") {
		const resolved = await resolveApiKey({
			provider: "anthropic",
			cfg: baseConfig,
			flagValue: opts.anthropicApiKey,
			flagName: "--anthropic-api-key",
			envVar: "ANTHROPIC_API_KEY",
			runtime
		});
		if (!resolved) return null;
		if (!await maybeSetResolvedApiKey(resolved, (value) => setAnthropicApiKey(value, void 0, apiKeyStorageOptions))) return null;
		return applyAuthProfileConfig(nextConfig, {
			profileId: "anthropic:default",
			provider: "anthropic",
			mode: "api_key"
		});
	}
	if (authChoice === "token") {
		const providerRaw = opts.tokenProvider?.trim();
		if (!providerRaw) {
			runtime.error("Missing --token-provider for --auth-choice token.");
			runtime.exit(1);
			return null;
		}
		const provider = normalizeProviderId(providerRaw);
		if (provider !== "anthropic") {
			runtime.error("Only --token-provider anthropic is supported for --auth-choice token.");
			runtime.exit(1);
			return null;
		}
		const tokenRaw = normalizeSecretInput(opts.token);
		if (!tokenRaw) {
			runtime.error("Missing --token for --auth-choice token.");
			runtime.exit(1);
			return null;
		}
		const tokenError = validateAnthropicSetupToken(tokenRaw);
		if (tokenError) {
			runtime.error(tokenError);
			runtime.exit(1);
			return null;
		}
		let expires;
		const expiresInRaw = opts.tokenExpiresIn?.trim();
		if (expiresInRaw) try {
			expires = Date.now() + parseDurationMs(expiresInRaw, { defaultUnit: "d" });
		} catch (err) {
			runtime.error(`Invalid --token-expires-in: ${String(err)}`);
			runtime.exit(1);
			return null;
		}
		const profileId = opts.tokenProfileId?.trim() || buildTokenProfileId({
			provider,
			name: ""
		});
		upsertAuthProfile({
			profileId,
			credential: {
				type: "token",
				provider,
				token: tokenRaw.trim(),
				...expires ? { expires } : {}
			}
		});
		return applyAuthProfileConfig(nextConfig, {
			profileId,
			provider,
			mode: "token"
		});
	}
	if (authChoice === "gemini-api-key") {
		const resolved = await resolveApiKey({
			provider: "google",
			cfg: baseConfig,
			flagValue: opts.geminiApiKey,
			flagName: "--gemini-api-key",
			envVar: "GEMINI_API_KEY",
			runtime
		});
		if (!resolved) return null;
		if (!await maybeSetResolvedApiKey(resolved, (value) => setGeminiApiKey(value, void 0, apiKeyStorageOptions))) return null;
		nextConfig = applyAuthProfileConfig(nextConfig, {
			profileId: "google:default",
			provider: "google",
			mode: "api_key"
		});
		return applyGoogleGeminiModelDefault(nextConfig).next;
	}
	if (authChoice === "zai-api-key" || authChoice === "zai-coding-global" || authChoice === "zai-coding-cn" || authChoice === "zai-global" || authChoice === "zai-cn") {
		const resolved = await resolveApiKey({
			provider: "zai",
			cfg: baseConfig,
			flagValue: opts.zaiApiKey,
			flagName: "--zai-api-key",
			envVar: "ZAI_API_KEY",
			runtime
		});
		if (!resolved) return null;
		if (!await maybeSetResolvedApiKey(resolved, (value) => setZaiApiKey(value, void 0, apiKeyStorageOptions))) return null;
		nextConfig = applyAuthProfileConfig(nextConfig, {
			profileId: "zai:default",
			provider: "zai",
			mode: "api_key"
		});
		let endpoint;
		let modelIdOverride;
		if (authChoice === "zai-coding-global") endpoint = "coding-global";
		else if (authChoice === "zai-coding-cn") endpoint = "coding-cn";
		else if (authChoice === "zai-global") endpoint = "global";
		else if (authChoice === "zai-cn") endpoint = "cn";
		else {
			const detected = await detectZaiEndpoint({ apiKey: resolved.key });
			if (detected) {
				endpoint = detected.endpoint;
				modelIdOverride = detected.modelId;
			} else endpoint = "global";
		}
		return applyZaiConfig(nextConfig, {
			endpoint,
			...modelIdOverride ? { modelId: modelIdOverride } : {}
		});
	}
	if (authChoice === "xiaomi-api-key") {
		const resolved = await resolveApiKey({
			provider: "xiaomi",
			cfg: baseConfig,
			flagValue: opts.xiaomiApiKey,
			flagName: "--xiaomi-api-key",
			envVar: "XIAOMI_API_KEY",
			runtime
		});
		if (!resolved) return null;
		if (!await maybeSetResolvedApiKey(resolved, (value) => setXiaomiApiKey(value, void 0, apiKeyStorageOptions))) return null;
		nextConfig = applyAuthProfileConfig(nextConfig, {
			profileId: "xiaomi:default",
			provider: "xiaomi",
			mode: "api_key"
		});
		return applyXiaomiConfig(nextConfig);
	}
	if (authChoice === "xai-api-key") {
		const resolved = await resolveApiKey({
			provider: "xai",
			cfg: baseConfig,
			flagValue: opts.xaiApiKey,
			flagName: "--xai-api-key",
			envVar: "XAI_API_KEY",
			runtime
		});
		if (!resolved) return null;
		if (!await maybeSetResolvedApiKey(resolved, (value) => setXaiApiKey(value, void 0, apiKeyStorageOptions))) return null;
		nextConfig = applyAuthProfileConfig(nextConfig, {
			profileId: "xai:default",
			provider: "xai",
			mode: "api_key"
		});
		return applyXaiConfig(nextConfig);
	}
	if (authChoice === "mistral-api-key") {
		const resolved = await resolveApiKey({
			provider: "mistral",
			cfg: baseConfig,
			flagValue: opts.mistralApiKey,
			flagName: "--mistral-api-key",
			envVar: "MISTRAL_API_KEY",
			runtime
		});
		if (!resolved) return null;
		if (!await maybeSetResolvedApiKey(resolved, (value) => setMistralApiKey(value, void 0, apiKeyStorageOptions))) return null;
		nextConfig = applyAuthProfileConfig(nextConfig, {
			profileId: "mistral:default",
			provider: "mistral",
			mode: "api_key"
		});
		return applyMistralConfig(nextConfig);
	}
	if (authChoice === "volcengine-api-key") {
		const resolved = await resolveApiKey({
			provider: "volcengine",
			cfg: baseConfig,
			flagValue: opts.volcengineApiKey,
			flagName: "--volcengine-api-key",
			envVar: "VOLCANO_ENGINE_API_KEY",
			runtime
		});
		if (!resolved) return null;
		if (!await maybeSetResolvedApiKey(resolved, (value) => setVolcengineApiKey(value, void 0, apiKeyStorageOptions))) return null;
		nextConfig = applyAuthProfileConfig(nextConfig, {
			profileId: "volcengine:default",
			provider: "volcengine",
			mode: "api_key"
		});
		return applyPrimaryModel(nextConfig, "volcengine-plan/ark-code-latest");
	}
	if (authChoice === "byteplus-api-key") {
		const resolved = await resolveApiKey({
			provider: "byteplus",
			cfg: baseConfig,
			flagValue: opts.byteplusApiKey,
			flagName: "--byteplus-api-key",
			envVar: "BYTEPLUS_API_KEY",
			runtime
		});
		if (!resolved) return null;
		if (!await maybeSetResolvedApiKey(resolved, (value) => setByteplusApiKey(value, void 0, apiKeyStorageOptions))) return null;
		nextConfig = applyAuthProfileConfig(nextConfig, {
			profileId: "byteplus:default",
			provider: "byteplus",
			mode: "api_key"
		});
		return applyPrimaryModel(nextConfig, "byteplus-plan/ark-code-latest");
	}
	if (authChoice === "qianfan-api-key") {
		const resolved = await resolveApiKey({
			provider: "qianfan",
			cfg: baseConfig,
			flagValue: opts.qianfanApiKey,
			flagName: "--qianfan-api-key",
			envVar: "QIANFAN_API_KEY",
			runtime
		});
		if (!resolved) return null;
		if (!await maybeSetResolvedApiKey(resolved, (value) => setQianfanApiKey(value, void 0, apiKeyStorageOptions))) return null;
		nextConfig = applyAuthProfileConfig(nextConfig, {
			profileId: "qianfan:default",
			provider: "qianfan",
			mode: "api_key"
		});
		return applyQianfanConfig(nextConfig);
	}
	if (authChoice === "openai-api-key") {
		const resolved = await resolveApiKey({
			provider: "openai",
			cfg: baseConfig,
			flagValue: opts.openaiApiKey,
			flagName: "--openai-api-key",
			envVar: "OPENAI_API_KEY",
			runtime
		});
		if (!resolved) return null;
		if (!await maybeSetResolvedApiKey(resolved, (value) => setOpenaiApiKey(value, void 0, apiKeyStorageOptions))) return null;
		nextConfig = applyAuthProfileConfig(nextConfig, {
			profileId: "openai:default",
			provider: "openai",
			mode: "api_key"
		});
		return applyOpenAIConfig(nextConfig);
	}
	if (authChoice === "openrouter-api-key") {
		const resolved = await resolveApiKey({
			provider: "openrouter",
			cfg: baseConfig,
			flagValue: opts.openrouterApiKey,
			flagName: "--openrouter-api-key",
			envVar: "OPENROUTER_API_KEY",
			runtime
		});
		if (!resolved) return null;
		if (!await maybeSetResolvedApiKey(resolved, (value) => setOpenrouterApiKey(value, void 0, apiKeyStorageOptions))) return null;
		nextConfig = applyAuthProfileConfig(nextConfig, {
			profileId: "openrouter:default",
			provider: "openrouter",
			mode: "api_key"
		});
		return applyOpenrouterConfig(nextConfig);
	}
	if (authChoice === "kilocode-api-key") {
		const resolved = await resolveApiKey({
			provider: "kilocode",
			cfg: baseConfig,
			flagValue: opts.kilocodeApiKey,
			flagName: "--kilocode-api-key",
			envVar: "KILOCODE_API_KEY",
			runtime
		});
		if (!resolved) return null;
		if (!await maybeSetResolvedApiKey(resolved, (value) => setKilocodeApiKey(value, void 0, apiKeyStorageOptions))) return null;
		nextConfig = applyAuthProfileConfig(nextConfig, {
			profileId: "kilocode:default",
			provider: "kilocode",
			mode: "api_key"
		});
		return applyKilocodeConfig(nextConfig);
	}
	if (authChoice === "litellm-api-key") {
		const resolved = await resolveApiKey({
			provider: "litellm",
			cfg: baseConfig,
			flagValue: opts.litellmApiKey,
			flagName: "--litellm-api-key",
			envVar: "LITELLM_API_KEY",
			runtime
		});
		if (!resolved) return null;
		if (!await maybeSetResolvedApiKey(resolved, (value) => setLitellmApiKey(value, void 0, apiKeyStorageOptions))) return null;
		nextConfig = applyAuthProfileConfig(nextConfig, {
			profileId: "litellm:default",
			provider: "litellm",
			mode: "api_key"
		});
		return applyLitellmConfig(nextConfig);
	}
	if (authChoice === "ai-gateway-api-key") {
		const resolved = await resolveApiKey({
			provider: "vercel-ai-gateway",
			cfg: baseConfig,
			flagValue: opts.aiGatewayApiKey,
			flagName: "--ai-gateway-api-key",
			envVar: "AI_GATEWAY_API_KEY",
			runtime
		});
		if (!resolved) return null;
		if (!await maybeSetResolvedApiKey(resolved, (value) => setVercelAiGatewayApiKey(value, void 0, apiKeyStorageOptions))) return null;
		nextConfig = applyAuthProfileConfig(nextConfig, {
			profileId: "vercel-ai-gateway:default",
			provider: "vercel-ai-gateway",
			mode: "api_key"
		});
		return applyVercelAiGatewayConfig(nextConfig);
	}
	if (authChoice === "cloudflare-ai-gateway-api-key") {
		const accountId = opts.cloudflareAiGatewayAccountId?.trim() ?? "";
		const gatewayId = opts.cloudflareAiGatewayGatewayId?.trim() ?? "";
		if (!accountId || !gatewayId) {
			runtime.error(["Auth choice \"cloudflare-ai-gateway-api-key\" requires Account ID and Gateway ID.", "Use --cloudflare-ai-gateway-account-id and --cloudflare-ai-gateway-gateway-id."].join("\n"));
			runtime.exit(1);
			return null;
		}
		const resolved = await resolveApiKey({
			provider: "cloudflare-ai-gateway",
			cfg: baseConfig,
			flagValue: opts.cloudflareAiGatewayApiKey,
			flagName: "--cloudflare-ai-gateway-api-key",
			envVar: "CLOUDFLARE_AI_GATEWAY_API_KEY",
			runtime
		});
		if (!resolved) return null;
		if (resolved.source !== "profile") {
			const stored = toStoredSecretInput(resolved);
			if (!stored) return null;
			await setCloudflareAiGatewayConfig(accountId, gatewayId, stored, void 0, apiKeyStorageOptions);
		}
		nextConfig = applyAuthProfileConfig(nextConfig, {
			profileId: "cloudflare-ai-gateway:default",
			provider: "cloudflare-ai-gateway",
			mode: "api_key"
		});
		return applyCloudflareAiGatewayConfig(nextConfig, {
			accountId,
			gatewayId
		});
	}
	const applyMoonshotApiKeyChoice = async (applyConfig) => {
		const resolved = await resolveApiKey({
			provider: "moonshot",
			cfg: baseConfig,
			flagValue: opts.moonshotApiKey,
			flagName: "--moonshot-api-key",
			envVar: "MOONSHOT_API_KEY",
			runtime
		});
		if (!resolved) return null;
		if (!await maybeSetResolvedApiKey(resolved, (value) => setMoonshotApiKey(value, void 0, apiKeyStorageOptions))) return null;
		nextConfig = applyAuthProfileConfig(nextConfig, {
			profileId: "moonshot:default",
			provider: "moonshot",
			mode: "api_key"
		});
		return applyConfig(nextConfig);
	};
	if (authChoice === "moonshot-api-key") return await applyMoonshotApiKeyChoice(applyMoonshotConfig);
	if (authChoice === "moonshot-api-key-cn") return await applyMoonshotApiKeyChoice(applyMoonshotConfigCn);
	if (authChoice === "kimi-code-api-key") {
		const resolved = await resolveApiKey({
			provider: "kimi-coding",
			cfg: baseConfig,
			flagValue: opts.kimiCodeApiKey,
			flagName: "--kimi-code-api-key",
			envVar: "KIMI_API_KEY",
			runtime
		});
		if (!resolved) return null;
		if (!await maybeSetResolvedApiKey(resolved, (value) => setKimiCodingApiKey(value, void 0, apiKeyStorageOptions))) return null;
		nextConfig = applyAuthProfileConfig(nextConfig, {
			profileId: "kimi-coding:default",
			provider: "kimi-coding",
			mode: "api_key"
		});
		return applyKimiCodeConfig(nextConfig);
	}
	if (authChoice === "synthetic-api-key") {
		const resolved = await resolveApiKey({
			provider: "synthetic",
			cfg: baseConfig,
			flagValue: opts.syntheticApiKey,
			flagName: "--synthetic-api-key",
			envVar: "SYNTHETIC_API_KEY",
			runtime
		});
		if (!resolved) return null;
		if (!await maybeSetResolvedApiKey(resolved, (value) => setSyntheticApiKey(value, void 0, apiKeyStorageOptions))) return null;
		nextConfig = applyAuthProfileConfig(nextConfig, {
			profileId: "synthetic:default",
			provider: "synthetic",
			mode: "api_key"
		});
		return applySyntheticConfig(nextConfig);
	}
	if (authChoice === "venice-api-key") {
		const resolved = await resolveApiKey({
			provider: "venice",
			cfg: baseConfig,
			flagValue: opts.veniceApiKey,
			flagName: "--venice-api-key",
			envVar: "VENICE_API_KEY",
			runtime
		});
		if (!resolved) return null;
		if (!await maybeSetResolvedApiKey(resolved, (value) => setVeniceApiKey(value, void 0, apiKeyStorageOptions))) return null;
		nextConfig = applyAuthProfileConfig(nextConfig, {
			profileId: "venice:default",
			provider: "venice",
			mode: "api_key"
		});
		return applyVeniceConfig(nextConfig);
	}
	if (authChoice === "minimax-cloud" || authChoice === "minimax-api" || authChoice === "minimax-api-key-cn" || authChoice === "minimax-api-lightning") {
		const isCn = authChoice === "minimax-api-key-cn";
		const providerId = isCn ? "minimax-cn" : "minimax";
		const profileId = `${providerId}:default`;
		const resolved = await resolveApiKey({
			provider: providerId,
			cfg: baseConfig,
			flagValue: opts.minimaxApiKey,
			flagName: "--minimax-api-key",
			envVar: "MINIMAX_API_KEY",
			runtime
		});
		if (!resolved) return null;
		if (!await maybeSetResolvedApiKey(resolved, (value) => setMinimaxApiKey(value, void 0, profileId, apiKeyStorageOptions))) return null;
		nextConfig = applyAuthProfileConfig(nextConfig, {
			profileId,
			provider: providerId,
			mode: "api_key"
		});
		const modelId = authChoice === "minimax-api-lightning" ? "MiniMax-M2.5-Lightning" : "MiniMax-M2.5";
		return isCn ? applyMinimaxApiConfigCn(nextConfig, modelId) : applyMinimaxApiConfig(nextConfig, modelId);
	}
	if (authChoice === "minimax") return applyMinimaxConfig(nextConfig);
	if (authChoice === "opencode-zen") {
		const resolved = await resolveApiKey({
			provider: "opencode",
			cfg: baseConfig,
			flagValue: opts.opencodeZenApiKey,
			flagName: "--opencode-zen-api-key",
			envVar: "OPENCODE_API_KEY (or OPENCODE_ZEN_API_KEY)",
			runtime
		});
		if (!resolved) return null;
		if (!await maybeSetResolvedApiKey(resolved, (value) => setOpencodeZenApiKey(value, void 0, apiKeyStorageOptions))) return null;
		nextConfig = applyAuthProfileConfig(nextConfig, {
			profileId: "opencode:default",
			provider: "opencode",
			mode: "api_key"
		});
		return applyOpencodeZenConfig(nextConfig);
	}
	if (authChoice === "together-api-key") {
		const resolved = await resolveApiKey({
			provider: "together",
			cfg: baseConfig,
			flagValue: opts.togetherApiKey,
			flagName: "--together-api-key",
			envVar: "TOGETHER_API_KEY",
			runtime
		});
		if (!resolved) return null;
		if (!await maybeSetResolvedApiKey(resolved, (value) => setTogetherApiKey(value, void 0, apiKeyStorageOptions))) return null;
		nextConfig = applyAuthProfileConfig(nextConfig, {
			profileId: "together:default",
			provider: "together",
			mode: "api_key"
		});
		return applyTogetherConfig(nextConfig);
	}
	if (authChoice === "huggingface-api-key") {
		const resolved = await resolveApiKey({
			provider: "huggingface",
			cfg: baseConfig,
			flagValue: opts.huggingfaceApiKey,
			flagName: "--huggingface-api-key",
			envVar: "HF_TOKEN",
			runtime
		});
		if (!resolved) return null;
		if (!await maybeSetResolvedApiKey(resolved, (value) => setHuggingfaceApiKey(value, void 0, apiKeyStorageOptions))) return null;
		nextConfig = applyAuthProfileConfig(nextConfig, {
			profileId: "huggingface:default",
			provider: "huggingface",
			mode: "api_key"
		});
		return applyHuggingfaceConfig(nextConfig);
	}
	if (authChoice === "custom-api-key") try {
		const customAuth = parseNonInteractiveCustomApiFlags({
			baseUrl: opts.customBaseUrl,
			modelId: opts.customModelId,
			compatibility: opts.customCompatibility,
			apiKey: opts.customApiKey,
			providerId: opts.customProviderId
		});
		const resolvedCustomApiKey = await resolveApiKey({
			provider: resolveCustomProviderId({
				config: nextConfig,
				baseUrl: customAuth.baseUrl,
				providerId: customAuth.providerId
			}).providerId,
			cfg: baseConfig,
			flagValue: customAuth.apiKey,
			flagName: "--custom-api-key",
			envVar: "CUSTOM_API_KEY",
			envVarName: "CUSTOM_API_KEY",
			runtime,
			required: false
		});
		let customApiKeyInput;
		if (resolvedCustomApiKey) if (requestedSecretInputMode === "ref") {
			const stored = toStoredSecretInput(resolvedCustomApiKey);
			if (!stored) return null;
			customApiKeyInput = stored;
		} else customApiKeyInput = resolvedCustomApiKey.key;
		const result = applyCustomApiConfig({
			config: nextConfig,
			baseUrl: customAuth.baseUrl,
			modelId: customAuth.modelId,
			compatibility: customAuth.compatibility,
			apiKey: customApiKeyInput,
			providerId: customAuth.providerId
		});
		if (result.providerIdRenamedFrom && result.providerId) runtime.log(`Custom provider ID "${result.providerIdRenamedFrom}" already exists for a different base URL. Using "${result.providerId}".`);
		return result.config;
	} catch (err) {
		if (err instanceof CustomApiError) {
			switch (err.code) {
				case "missing_required":
				case "invalid_compatibility":
					runtime.error(err.message);
					break;
				default:
					runtime.error(`Invalid custom provider config: ${err.message}`);
					break;
			}
			runtime.exit(1);
			return null;
		}
		const reason = err instanceof Error ? err.message : String(err);
		runtime.error(`Invalid custom provider config: ${reason}`);
		runtime.exit(1);
		return null;
	}
	if (authChoice === "oauth" || authChoice === "chutes" || authChoice === "openai-codex" || authChoice === "qwen-portal" || authChoice === "minimax-portal") {
		runtime.error("OAuth requires interactive mode.");
		runtime.exit(1);
		return null;
	}
	return nextConfig;
}

//#endregion
export { applyNonInteractiveAuthChoice };