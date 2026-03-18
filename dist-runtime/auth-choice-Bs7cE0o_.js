import "./redact-qojvLPM7.js";
import "./errors-nCFRNLA6.js";
import "./unhandled-rejections-DGuis5pC.js";
import "./globals-B6h30oSy.js";
import "./paths-DqbqmTPe.js";
import "./theme-CL08MjAq.js";
import "./subsystem-CZwunM2N.js";
import "./ansi-CeMmGDji.js";
import "./boolean-B938tROv.js";
import "./env--LwFRA3k.js";
import "./warning-filter-xAwZkSAQ.js";
import "./utils-BiUV1eIQ.js";
import "./links-DPi3kBux.js";
import { c as resolveApiKeyForProfile, n as resolveAuthProfileOrder, p as ensureAuthProfileStore, x_ as normalizeSecretInputModeInput, yb as resolveEnvApiKey } from "./auth-profiles-DAOR1fRn.js";
import { it as normalizeOptionalSecretInput } from "./plugins-allowlist-E4LSkJ7R.js";
import "./registry-ep1yQ6WN.js";
import "./fetch-COjVSrBr.js";
import "./config-state-CkhXLglq.js";
import "./filter-Qe6Ch68_.js";
import "./manifest-registry-DZywV-kg.js";
import { Fn as resolveDefaultSecretProviderAlias } from "./method-scopes-CLHNYIU6.js";
import "./plugins-DC9n978g.js";
import "./brew-CAA1PAwX.js";
import { a as resolveAgentDir, d as resolveAgentWorkspaceDir, f as resolveDefaultAgentId, j as resolveDefaultAgentWorkspaceDir } from "./agent-scope-C0PckUtv.js";
import "./logger-DLmJXd-S.js";
import "./exec-BmPfiSbq.js";
import "./env-overrides-Dbt5eAZJ.js";
import "./safe-text-BN5UJvnR.js";
import "./version-Dubp0iGu.js";
import "./config-DZ3oWznn.js";
import "./workspace-dirs-Ejflbukt.js";
import "./search-manager-CVctuSlw.js";
import "./ip-Cdtea-sx.js";
import "./device-metadata-normalization-a2oQYp64.js";
import "./query-expansion-V82ct97U.js";
import "./command-secret-targets-7sQA1Mwd.js";
import "./frontmatter-UI6LO8NQ.js";
import "./path-alias-guards-SF-nwQor.js";
import "./skills-DUmWDILI.js";
import "./commands-BfMCtxuV.js";
import "./ports-D4BnBb9r.js";
import "./ports-lsof-CCbcofNf.js";
import "./ssh-tunnel-DMTCLBKm.js";
import "./mime-h80iV1FL.js";
import "./delivery-queue-_j5H8TrE.js";
import "./paths-55bRPK_d.js";
import "./session-cost-usage-DqIvfSaZ.js";
import "./fetch-wLdC1F30.js";
import "./identity-file-GRgHESaI.js";
import "./dm-policy-shared-QWD8iFx0.js";
import "./multimodal-IUqnzBU8.js";
import "./memory-search-ur8rDo4q.js";
import "./prompt-style-CEH2A0QE.js";
import "./secret-file-CGJfrW4K.js";
import "./token-BE5e8NTA.js";
import "./restart-stale-pids-Be6QOzfZ.js";
import "./accounts-C8zoA5z4.js";
import "./audit-BTP1ZwHz.js";
import "./cli-utils-DRykF2zj.js";
import "./issue-format-CBjhFckx.js";
import { r as applyAuthProfileConfig } from "./onboard-auth.config-shared-B0GfsgVQ.js";
import "./shared-GdtNjdoh.js";
import { a as setCloudflareAiGatewayConfig, o as setLitellmApiKey, r as applyCloudflareAiGatewayConfig, t as applyLitellmConfig } from "./onboard-auth-Vt8VHD8O.js";
import { t as enablePluginInConfig } from "./enable-Fw1VqrSH.js";
import "./auth-choice-legacy-DTPPkr0E.js";
import { r as normalizeApiKeyTokenProviderAuthChoice, t as resolvePreferredProviderForAuthChoice } from "./auth-choice.preferred-provider-DdMPFsaS.js";
import "./model-picker-CrWwjdJy.js";
import { a as resolveCustomProviderId, n as applyCustomApiConfig, r as parseNonInteractiveCustomApiFlags, t as CustomApiError } from "./onboard-custom-GtmE6oqt.js";
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
async function applySimpleNonInteractiveApiKeyChoice(params) {
	if (params.authChoice !== "litellm-api-key") return;
	const resolved = await params.resolveApiKey({
		provider: "litellm",
		cfg: params.baseConfig,
		flagValue: params.opts.litellmApiKey,
		flagName: "--litellm-api-key",
		envVar: "LITELLM_API_KEY",
		runtime: params.runtime
	});
	if (!resolved) return null;
	if (!await params.maybeSetResolvedApiKey(resolved, (value) => setLitellmApiKey(value, void 0, params.apiKeyStorageOptions))) return null;
	return applyLitellmConfig(applyAuthProfileConfig(params.nextConfig, {
		profileId: "litellm:default",
		provider: "litellm",
		mode: "api_key"
	}));
}
//#endregion
//#region src/commands/onboard-non-interactive/local/auth-choice.plugin-providers.ts
const PROVIDER_PLUGIN_CHOICE_PREFIX = "provider-plugin:";
async function loadPluginProviderRuntime() {
	return import("./auth-choice.plugin-providers.runtime-CELMtpgM.js");
}
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
	const agentDir = resolveAgentDir(params.nextConfig, agentId);
	const workspaceDir = resolveAgentWorkspaceDir(params.nextConfig, agentId) ?? resolveDefaultAgentWorkspaceDir();
	const preferredProviderId = (params.authChoice.startsWith(PROVIDER_PLUGIN_CHOICE_PREFIX) ? params.authChoice.slice(16).split(":", 1)[0]?.trim() : void 0) || await resolvePreferredProviderForAuthChoice({
		choice: params.authChoice,
		config: params.nextConfig,
		workspaceDir
	});
	const resolutionConfig = buildIsolatedProviderResolutionConfig(params.nextConfig, preferredProviderId);
	const { resolveOwningPluginIdsForProvider, resolveProviderPluginChoice, resolvePluginProviders } = await loadPluginProviderRuntime();
	const providerChoice = resolveProviderPluginChoice({
		providers: resolvePluginProviders({
			config: resolutionConfig,
			workspaceDir,
			onlyPluginIds: preferredProviderId ? resolveOwningPluginIdsForProvider({
				provider: preferredProviderId,
				config: resolutionConfig,
				workspaceDir
			}) : void 0,
			bundledProviderAllowlistCompat: true,
			bundledProviderVitestCompat: true
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
		agentDir,
		workspaceDir,
		resolveApiKey: params.resolveApiKey,
		toApiKeyCredential: params.toApiKeyCredential
	});
}
//#endregion
//#region src/commands/onboard-non-interactive/local/auth-choice.ts
async function applyNonInteractiveAuthChoice(params) {
	const { opts, runtime, baseConfig } = params;
	const authChoice = normalizeApiKeyTokenProviderAuthChoice({
		authChoice: params.authChoice,
		tokenProvider: opts.tokenProvider,
		config: params.nextConfig,
		env: process.env
	});
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
	if (authChoice === "oauth" || authChoice === "chutes" || authChoice === "qwen-portal" || authChoice === "minimax-global-oauth" || authChoice === "minimax-cn-oauth") {
		runtime.error("OAuth requires interactive mode.");
		runtime.exit(1);
		return null;
	}
	return nextConfig;
}
//#endregion
export { applyNonInteractiveAuthChoice };
