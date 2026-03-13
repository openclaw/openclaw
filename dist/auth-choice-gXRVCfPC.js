import "./subsystem-DVwhOlEq.js";
import "./paths-BfR2LXbA.js";
import "./boolean-BHdNsbzF.js";
import { Dv as normalizeSecretInput, Ev as normalizeOptionalSecretInput, O as normalizeProviderId, R as resolvePluginProviders, U_ as resolveEnvApiKey, f as upsertAuthProfile, i as resolveApiKeyForProfile, n as resolveAuthProfileOrder, p as ensureAuthProfileStore } from "./auth-profiles-CAw5gP6f.js";
import { d as resolveAgentWorkspaceDir, f as resolveDefaultAgentId, j as resolveDefaultAgentWorkspaceDir } from "./agent-scope-DBEC2O3x.js";
import "./utils-8QNki08A.js";
import "./boundary-file-read-CcBHg_z-.js";
import "./logger-CDI_b4HB.js";
import "./exec-CHkvLtoM.js";
import "./github-copilot-token-CcBrBN3h.js";
import "./registry-B23eaqdH.js";
import "./skills-D75zdym7.js";
import "./frontmatter-BsxcWDrh.js";
import "./env-overrides-DWoj3eoQ.js";
import "./version-N--ZkDj4.js";
import { i as parseDurationMs } from "./search-manager-B1FsI6Ow.js";
import { At as resolveDefaultSecretProviderAlias } from "./plugins-BKDaOrHv.js";
import "./query-expansion-kdDusy7Q.js";
import "./redact-D9pXgQ9w.js";
import "./cli-utils-Cikq4_a8.js";
import "./fetch-ZNxqGXAR.js";
import "./path-alias-guards-Bq601o2U.js";
import "./delivery-queue-O9EZYTUe.js";
import "./paths-QMxjnO9x.js";
import "./session-cost-usage-6HYiRnfr.js";
import "./prompt-style-2BF77KhS.js";
import "./links-BpBLDDXV.js";
import "./provider-env-vars-DW9Ss6dw.js";
import { t as enablePluginInConfig } from "./enable-4ooqBfl0.js";
import { a as normalizeSecretInputModeInput } from "./auth-choice.apply-helpers-C8fI-9Ep.js";
import "./issue-format-jHeRIpoa.js";
import { At as setTogetherApiKey, B as applySyntheticConfig, Ct as setMoonshotApiKey, Dt as setOpenrouterApiKey, E as applyMistralConfig, Et as setOpencodeZenApiKey, Ft as setXiaomiApiKey, H as applyTogetherConfig, I as applyOpenrouterConfig, It as setZaiApiKey, J as applyXiaomiConfig, K as applyXaiConfig, M as applyMoonshotConfig, Mt as setVercelAiGatewayApiKey, N as applyMoonshotConfigCn, Nt as setVolcengineApiKey, O as applyModelStudioConfig, Ot as setQianfanApiKey, Pt as setXaiApiKey, Q as applyLitellmConfig, R as applyQianfanConfig, S as applyKilocodeConfig, St as setModelStudioApiKey, Tt as setOpencodeGoApiKey, W as applyVeniceConfig, X as applyZaiConfig, _t as setKilocodeApiKey, b as applyHuggingfaceConfig, bt as setMinimaxApiKey, et as applyCloudflareAiGatewayConfig, ft as setAnthropicApiKey, g as applyMinimaxApiConfigCn, gt as setHuggingfaceApiKey, h as applyMinimaxApiConfig, ht as setGeminiApiKey, jt as setVeniceApiKey, k as applyModelStudioConfigCn, kt as setSyntheticApiKey, l as applyOpencodeGoConfig, mt as setCloudflareAiGatewayConfig, nt as applyVercelAiGatewayConfig, p as applyOpencodeZenConfig, pt as setByteplusApiKey, vt as setKimiCodingApiKey, w as applyKimiCodeConfig, wt as setOpenaiApiKey, xt as setMistralApiKey, y as applyAuthProfileConfig, yt as setLitellmApiKey } from "./provider-auth-helpers-BygHxwmm.js";
import { n as validateAnthropicSetupToken, t as buildTokenProfileId } from "./auth-token-DhmL38FQ.js";
import { r as resolveProviderPluginChoice } from "./provider-wizard-D0dlzJPh.js";
import { a as detectZaiEndpoint, r as applyOpenAIConfig, s as applyGoogleGeminiModelDefault, t as resolvePreferredProviderForAuthChoice } from "./auth-choice.preferred-provider-M6BWK6_E.js";
import { r as applyPrimaryModel } from "./model-picker-CqMaZ-5Q.js";
import { i as parseNonInteractiveCustomApiFlags, n as applyCustomApiConfig, o as resolveCustomProviderId, t as CustomApiError } from "./onboard-custom-qlPxntvR.js";
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
//#region src/commands/onboard-non-interactive/local/auth-choice.api-key-providers.ts
function buildSimpleApiKeyAuthChoices(params) {
	const withStorage = (setter) => (value, options) => setter(value, void 0, options);
	return [
		{
			authChoices: ["apiKey"],
			provider: "anthropic",
			flagValue: params.opts.anthropicApiKey,
			flagName: "--anthropic-api-key",
			envVar: "ANTHROPIC_API_KEY",
			profileId: "anthropic:default",
			setCredential: withStorage(setAnthropicApiKey),
			applyConfig: (cfg) => applyAuthProfileConfig(cfg, {
				profileId: "anthropic:default",
				provider: "anthropic",
				mode: "api_key"
			})
		},
		{
			authChoices: ["gemini-api-key"],
			provider: "google",
			flagValue: params.opts.geminiApiKey,
			flagName: "--gemini-api-key",
			envVar: "GEMINI_API_KEY",
			profileId: "google:default",
			setCredential: withStorage(setGeminiApiKey),
			applyConfig: (cfg) => applyGoogleGeminiModelDefault(applyAuthProfileConfig(cfg, {
				profileId: "google:default",
				provider: "google",
				mode: "api_key"
			})).next
		},
		{
			authChoices: ["xiaomi-api-key"],
			provider: "xiaomi",
			flagValue: params.opts.xiaomiApiKey,
			flagName: "--xiaomi-api-key",
			envVar: "XIAOMI_API_KEY",
			profileId: "xiaomi:default",
			setCredential: withStorage(setXiaomiApiKey),
			applyConfig: (cfg) => applyXiaomiConfig(applyAuthProfileConfig(cfg, {
				profileId: "xiaomi:default",
				provider: "xiaomi",
				mode: "api_key"
			}))
		},
		{
			authChoices: ["xai-api-key"],
			provider: "xai",
			flagValue: params.opts.xaiApiKey,
			flagName: "--xai-api-key",
			envVar: "XAI_API_KEY",
			profileId: "xai:default",
			setCredential: withStorage(setXaiApiKey),
			applyConfig: (cfg) => applyXaiConfig(applyAuthProfileConfig(cfg, {
				profileId: "xai:default",
				provider: "xai",
				mode: "api_key"
			}))
		},
		{
			authChoices: ["mistral-api-key"],
			provider: "mistral",
			flagValue: params.opts.mistralApiKey,
			flagName: "--mistral-api-key",
			envVar: "MISTRAL_API_KEY",
			profileId: "mistral:default",
			setCredential: withStorage(setMistralApiKey),
			applyConfig: (cfg) => applyMistralConfig(applyAuthProfileConfig(cfg, {
				profileId: "mistral:default",
				provider: "mistral",
				mode: "api_key"
			}))
		},
		{
			authChoices: ["volcengine-api-key"],
			provider: "volcengine",
			flagValue: params.opts.volcengineApiKey,
			flagName: "--volcengine-api-key",
			envVar: "VOLCANO_ENGINE_API_KEY",
			profileId: "volcengine:default",
			setCredential: withStorage(setVolcengineApiKey),
			applyConfig: (cfg) => applyPrimaryModel(applyAuthProfileConfig(cfg, {
				profileId: "volcengine:default",
				provider: "volcengine",
				mode: "api_key"
			}), "volcengine-plan/ark-code-latest")
		},
		{
			authChoices: ["byteplus-api-key"],
			provider: "byteplus",
			flagValue: params.opts.byteplusApiKey,
			flagName: "--byteplus-api-key",
			envVar: "BYTEPLUS_API_KEY",
			profileId: "byteplus:default",
			setCredential: withStorage(setByteplusApiKey),
			applyConfig: (cfg) => applyPrimaryModel(applyAuthProfileConfig(cfg, {
				profileId: "byteplus:default",
				provider: "byteplus",
				mode: "api_key"
			}), "byteplus-plan/ark-code-latest")
		},
		{
			authChoices: ["qianfan-api-key"],
			provider: "qianfan",
			flagValue: params.opts.qianfanApiKey,
			flagName: "--qianfan-api-key",
			envVar: "QIANFAN_API_KEY",
			profileId: "qianfan:default",
			setCredential: withStorage(setQianfanApiKey),
			applyConfig: (cfg) => applyQianfanConfig(applyAuthProfileConfig(cfg, {
				profileId: "qianfan:default",
				provider: "qianfan",
				mode: "api_key"
			}))
		},
		{
			authChoices: ["modelstudio-api-key-cn"],
			provider: "modelstudio",
			flagValue: params.opts.modelstudioApiKeyCn,
			flagName: "--modelstudio-api-key-cn",
			envVar: "MODELSTUDIO_API_KEY",
			profileId: "modelstudio:default",
			setCredential: withStorage(setModelStudioApiKey),
			applyConfig: (cfg) => applyModelStudioConfigCn(applyAuthProfileConfig(cfg, {
				profileId: "modelstudio:default",
				provider: "modelstudio",
				mode: "api_key"
			}))
		},
		{
			authChoices: ["modelstudio-api-key"],
			provider: "modelstudio",
			flagValue: params.opts.modelstudioApiKey,
			flagName: "--modelstudio-api-key",
			envVar: "MODELSTUDIO_API_KEY",
			profileId: "modelstudio:default",
			setCredential: withStorage(setModelStudioApiKey),
			applyConfig: (cfg) => applyModelStudioConfig(applyAuthProfileConfig(cfg, {
				profileId: "modelstudio:default",
				provider: "modelstudio",
				mode: "api_key"
			}))
		},
		{
			authChoices: ["openai-api-key"],
			provider: "openai",
			flagValue: params.opts.openaiApiKey,
			flagName: "--openai-api-key",
			envVar: "OPENAI_API_KEY",
			profileId: "openai:default",
			setCredential: withStorage(setOpenaiApiKey),
			applyConfig: (cfg) => applyOpenAIConfig(applyAuthProfileConfig(cfg, {
				profileId: "openai:default",
				provider: "openai",
				mode: "api_key"
			}))
		},
		{
			authChoices: ["openrouter-api-key"],
			provider: "openrouter",
			flagValue: params.opts.openrouterApiKey,
			flagName: "--openrouter-api-key",
			envVar: "OPENROUTER_API_KEY",
			profileId: "openrouter:default",
			setCredential: withStorage(setOpenrouterApiKey),
			applyConfig: (cfg) => applyOpenrouterConfig(applyAuthProfileConfig(cfg, {
				profileId: "openrouter:default",
				provider: "openrouter",
				mode: "api_key"
			}))
		},
		{
			authChoices: ["kilocode-api-key"],
			provider: "kilocode",
			flagValue: params.opts.kilocodeApiKey,
			flagName: "--kilocode-api-key",
			envVar: "KILOCODE_API_KEY",
			profileId: "kilocode:default",
			setCredential: withStorage(setKilocodeApiKey),
			applyConfig: (cfg) => applyKilocodeConfig(applyAuthProfileConfig(cfg, {
				profileId: "kilocode:default",
				provider: "kilocode",
				mode: "api_key"
			}))
		},
		{
			authChoices: ["litellm-api-key"],
			provider: "litellm",
			flagValue: params.opts.litellmApiKey,
			flagName: "--litellm-api-key",
			envVar: "LITELLM_API_KEY",
			profileId: "litellm:default",
			setCredential: withStorage(setLitellmApiKey),
			applyConfig: (cfg) => applyLitellmConfig(applyAuthProfileConfig(cfg, {
				profileId: "litellm:default",
				provider: "litellm",
				mode: "api_key"
			}))
		},
		{
			authChoices: ["ai-gateway-api-key"],
			provider: "vercel-ai-gateway",
			flagValue: params.opts.aiGatewayApiKey,
			flagName: "--ai-gateway-api-key",
			envVar: "AI_GATEWAY_API_KEY",
			profileId: "vercel-ai-gateway:default",
			setCredential: withStorage(setVercelAiGatewayApiKey),
			applyConfig: (cfg) => applyVercelAiGatewayConfig(applyAuthProfileConfig(cfg, {
				profileId: "vercel-ai-gateway:default",
				provider: "vercel-ai-gateway",
				mode: "api_key"
			}))
		},
		{
			authChoices: ["moonshot-api-key"],
			provider: "moonshot",
			flagValue: params.opts.moonshotApiKey,
			flagName: "--moonshot-api-key",
			envVar: "MOONSHOT_API_KEY",
			profileId: "moonshot:default",
			setCredential: withStorage(setMoonshotApiKey),
			applyConfig: (cfg) => applyMoonshotConfig(applyAuthProfileConfig(cfg, {
				profileId: "moonshot:default",
				provider: "moonshot",
				mode: "api_key"
			}))
		},
		{
			authChoices: ["moonshot-api-key-cn"],
			provider: "moonshot",
			flagValue: params.opts.moonshotApiKey,
			flagName: "--moonshot-api-key",
			envVar: "MOONSHOT_API_KEY",
			profileId: "moonshot:default",
			setCredential: withStorage(setMoonshotApiKey),
			applyConfig: (cfg) => applyMoonshotConfigCn(applyAuthProfileConfig(cfg, {
				profileId: "moonshot:default",
				provider: "moonshot",
				mode: "api_key"
			}))
		},
		{
			authChoices: ["kimi-code-api-key"],
			provider: "kimi-coding",
			flagValue: params.opts.kimiCodeApiKey,
			flagName: "--kimi-code-api-key",
			envVar: "KIMI_API_KEY",
			profileId: "kimi-coding:default",
			setCredential: withStorage(setKimiCodingApiKey),
			applyConfig: (cfg) => applyKimiCodeConfig(applyAuthProfileConfig(cfg, {
				profileId: "kimi-coding:default",
				provider: "kimi-coding",
				mode: "api_key"
			}))
		},
		{
			authChoices: ["synthetic-api-key"],
			provider: "synthetic",
			flagValue: params.opts.syntheticApiKey,
			flagName: "--synthetic-api-key",
			envVar: "SYNTHETIC_API_KEY",
			profileId: "synthetic:default",
			setCredential: withStorage(setSyntheticApiKey),
			applyConfig: (cfg) => applySyntheticConfig(applyAuthProfileConfig(cfg, {
				profileId: "synthetic:default",
				provider: "synthetic",
				mode: "api_key"
			}))
		},
		{
			authChoices: ["venice-api-key"],
			provider: "venice",
			flagValue: params.opts.veniceApiKey,
			flagName: "--venice-api-key",
			envVar: "VENICE_API_KEY",
			profileId: "venice:default",
			setCredential: withStorage(setVeniceApiKey),
			applyConfig: (cfg) => applyVeniceConfig(applyAuthProfileConfig(cfg, {
				profileId: "venice:default",
				provider: "venice",
				mode: "api_key"
			}))
		},
		{
			authChoices: ["opencode-zen"],
			provider: "opencode",
			flagValue: params.opts.opencodeZenApiKey,
			flagName: "--opencode-zen-api-key",
			envVar: "OPENCODE_API_KEY (or OPENCODE_ZEN_API_KEY)",
			profileId: "opencode:default",
			setCredential: withStorage(setOpencodeZenApiKey),
			applyConfig: (cfg) => applyOpencodeZenConfig(applyAuthProfileConfig(cfg, {
				profileId: "opencode:default",
				provider: "opencode",
				mode: "api_key"
			}))
		},
		{
			authChoices: ["opencode-go"],
			provider: "opencode-go",
			flagValue: params.opts.opencodeGoApiKey,
			flagName: "--opencode-go-api-key",
			envVar: "OPENCODE_API_KEY",
			profileId: "opencode-go:default",
			setCredential: withStorage(setOpencodeGoApiKey),
			applyConfig: (cfg) => applyOpencodeGoConfig(applyAuthProfileConfig(cfg, {
				profileId: "opencode-go:default",
				provider: "opencode-go",
				mode: "api_key"
			}))
		},
		{
			authChoices: ["together-api-key"],
			provider: "together",
			flagValue: params.opts.togetherApiKey,
			flagName: "--together-api-key",
			envVar: "TOGETHER_API_KEY",
			profileId: "together:default",
			setCredential: withStorage(setTogetherApiKey),
			applyConfig: (cfg) => applyTogetherConfig(applyAuthProfileConfig(cfg, {
				profileId: "together:default",
				provider: "together",
				mode: "api_key"
			}))
		},
		{
			authChoices: ["huggingface-api-key"],
			provider: "huggingface",
			flagValue: params.opts.huggingfaceApiKey,
			flagName: "--huggingface-api-key",
			envVar: "HF_TOKEN",
			profileId: "huggingface:default",
			setCredential: withStorage(setHuggingfaceApiKey),
			applyConfig: (cfg) => applyHuggingfaceConfig(applyAuthProfileConfig(cfg, {
				profileId: "huggingface:default",
				provider: "huggingface",
				mode: "api_key"
			}))
		}
	];
}
async function applySimpleNonInteractiveApiKeyChoice(params) {
	const definition = buildSimpleApiKeyAuthChoices({ opts: params.opts }).find((entry) => entry.authChoices.includes(params.authChoice));
	if (!definition) return;
	const resolved = await params.resolveApiKey({
		provider: definition.provider,
		cfg: params.baseConfig,
		flagValue: definition.flagValue,
		flagName: definition.flagName,
		envVar: definition.envVar,
		runtime: params.runtime
	});
	if (!resolved) return null;
	if (!await params.maybeSetResolvedApiKey(resolved, (value) => definition.setCredential(value, params.apiKeyStorageOptions))) return null;
	return definition.applyConfig(params.nextConfig);
}
//#endregion
//#region src/commands/onboard-non-interactive/local/auth-choice.plugin-providers.ts
function buildIsolatedProviderResolutionConfig(cfg, providerId) {
	if (!providerId) return cfg;
	const allow = new Set(cfg.plugins?.allow ?? []);
	allow.add(providerId);
	return {
		...cfg,
		plugins: {
			...cfg.plugins,
			allow: Array.from(allow),
			entries: {
				...cfg.plugins?.entries,
				[providerId]: {
					...cfg.plugins?.entries?.[providerId],
					enabled: true
				}
			}
		}
	};
}
async function applyNonInteractivePluginProviderChoice(params) {
	const agentId = resolveDefaultAgentId(params.nextConfig);
	const workspaceDir = resolveAgentWorkspaceDir(params.nextConfig, agentId) ?? resolveDefaultAgentWorkspaceDir();
	const preferredProviderId = (params.authChoice.startsWith("provider-plugin:") ? params.authChoice.slice(16).split(":", 1)[0]?.trim() : void 0) || resolvePreferredProviderForAuthChoice({
		choice: params.authChoice,
		config: params.nextConfig,
		workspaceDir
	});
	const providerChoice = resolveProviderPluginChoice({
		providers: resolvePluginProviders({
			config: buildIsolatedProviderResolutionConfig(params.nextConfig, preferredProviderId),
			workspaceDir
		}),
		choice: params.authChoice
	});
	if (!providerChoice) return;
	const enableResult = enablePluginInConfig(params.nextConfig, providerChoice.provider.pluginId ?? providerChoice.provider.id);
	if (!enableResult.enabled) {
		params.runtime.error(`${providerChoice.provider.label} plugin is disabled (${enableResult.reason ?? "blocked"}).`);
		params.runtime.exit(1);
		return null;
	}
	const method = providerChoice.method;
	if (!method.runNonInteractive) {
		params.runtime.error([`Auth choice "${params.authChoice}" requires interactive mode.`, `The ${providerChoice.provider.label} provider plugin does not implement non-interactive setup.`].join("\n"));
		params.runtime.exit(1);
		return null;
	}
	return method.runNonInteractive({
		authChoice: params.authChoice,
		config: enableResult.config,
		baseConfig: params.baseConfig,
		opts: params.opts,
		runtime: params.runtime,
		workspaceDir,
		resolveApiKey: params.resolveApiKey,
		toApiKeyCredential: params.toApiKeyCredential
	});
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
	const toApiKeyCredential = (params) => {
		if (requestedSecretInputMode === "ref" && params.resolved.source === "env") {
			if (!params.resolved.envVarName) {
				runtime.error([`--secret-input-mode ref requires an explicit environment variable for provider "${params.provider}".`, "Set the provider API key env var and retry, or use --secret-input-mode plaintext."].join("\n"));
				runtime.exit(1);
				return null;
			}
			return {
				type: "api_key",
				provider: params.provider,
				keyRef: {
					source: "env",
					provider: resolveDefaultSecretProviderAlias(baseConfig, "env", { preferFirstProviderForSource: true }),
					id: params.resolved.envVarName
				},
				...params.email ? { email: params.email } : {},
				...params.metadata ? { metadata: params.metadata } : {}
			};
		}
		return {
			type: "api_key",
			provider: params.provider,
			key: params.resolved.key,
			...params.email ? { email: params.email } : {},
			...params.metadata ? { metadata: params.metadata } : {}
		};
	};
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
	const pluginProviderChoice = await applyNonInteractivePluginProviderChoice({
		nextConfig,
		authChoice,
		opts,
		runtime,
		baseConfig,
		resolveApiKey: (input) => resolveApiKey({
			...input,
			cfg: baseConfig,
			runtime
		}),
		toApiKeyCredential
	});
	if (pluginProviderChoice !== void 0) return pluginProviderChoice;
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
	const simpleApiKeyChoice = await applySimpleNonInteractiveApiKeyChoice({
		authChoice,
		nextConfig,
		baseConfig,
		opts,
		runtime,
		apiKeyStorageOptions,
		resolveApiKey,
		maybeSetResolvedApiKey
	});
	if (simpleApiKeyChoice !== void 0) return simpleApiKeyChoice;
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
	const REMOVED_MINIMAX_CHOICES = {
		minimax: "minimax-global-api",
		"minimax-api": "minimax-global-api",
		"minimax-cloud": "minimax-global-api",
		"minimax-api-lightning": "minimax-global-api",
		"minimax-api-key-cn": "minimax-cn-api"
	};
	if (Object.prototype.hasOwnProperty.call(REMOVED_MINIMAX_CHOICES, authChoice)) {
		const replacement = REMOVED_MINIMAX_CHOICES[authChoice];
		runtime.error(`"${authChoice}" is no longer supported. Use --auth-choice ${replacement} instead.`);
		runtime.exit(1);
		return null;
	}
	if (authChoice === "minimax-global-api" || authChoice === "minimax-cn-api") {
		const isCn = authChoice === "minimax-cn-api";
		const profileId = isCn ? "minimax:cn" : "minimax:global";
		const resolved = await resolveApiKey({
			provider: "minimax",
			cfg: baseConfig,
			flagValue: opts.minimaxApiKey,
			flagName: "--minimax-api-key",
			envVar: "MINIMAX_API_KEY",
			runtime,
			allowProfile: false
		});
		if (!resolved) return null;
		if (!await maybeSetResolvedApiKey(resolved, (value) => setMinimaxApiKey(value, void 0, profileId, apiKeyStorageOptions))) return null;
		nextConfig = applyAuthProfileConfig(nextConfig, {
			profileId,
			provider: "minimax",
			mode: "api_key"
		});
		return isCn ? applyMinimaxApiConfigCn(nextConfig) : applyMinimaxApiConfig(nextConfig);
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
	if (authChoice === "oauth" || authChoice === "chutes" || authChoice === "openai-codex" || authChoice === "qwen-portal" || authChoice === "minimax-global-oauth" || authChoice === "minimax-cn-oauth") {
		runtime.error("OAuth requires interactive mode.");
		runtime.exit(1);
		return null;
	}
	return nextConfig;
}
//#endregion
export { applyNonInteractiveAuthChoice };
