import { s as hasConfiguredSecretInput } from "../../types.secrets-DwPik3M8.js";
import { t as normalizeOptionalSecretInput } from "../../normalize-secret-input-CsdRhsMj.js";
import { i as removeProviderAuthProfilesWithLock } from "../../profiles-9GB1thhi.js";
import { t as ensureApiKeyFromEnvOrPrompt } from "../../provider-auth-input-DMNIEm93.js";
import { n as buildApiKeyCredential } from "../../provider-auth-helpers-BZ5Z8RV6.js";
import "../../provider-auth-BtRKd5us.js";
import { h as withAgentModelAliases } from "../../provider-onboard-MLXAQX8H.js";
import { n as configureOpenAICompatibleSelfHostedProviderNonInteractive, t as applyProviderDefaultModel } from "../../provider-self-hosted-setup-CA-6JZso.js";
import "../../provider-setup-DU7un2Vp.js";
import { t as WizardCancelledError } from "../../prompts-E0FayNjJ.js";
import "../../setup-DPvocg6M.js";
import { A as LMSTUDIO_DOCKER_HOST_BASE_URL, C as resolveLoadedContextWindow, D as LMSTUDIO_DEFAULT_INFERENCE_BASE_URL, E as LMSTUDIO_DEFAULT_EMBEDDING_MODEL, F as LMSTUDIO_PROVIDER_LABEL, M as LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER, N as LMSTUDIO_MODEL_PLACEHOLDER, O as LMSTUDIO_DEFAULT_LOAD_CONTEXT_LENGTH, P as LMSTUDIO_PROVIDER_ID, S as resolveLmstudioServerBase, T as LMSTUDIO_DEFAULT_BASE_URL, _ as normalizeLmstudioConfiguredCatalogEntry, a as resolveLmstudioConfiguredApiKey, b as resolveLmstudioReasoningCapability, c as resolveLmstudioRuntimeApiKey, d as shouldUseLmstudioApiKeyPlaceholder, g as normalizeLmstudioConfiguredCatalogEntries, h as mapLmstudioWireModelsToConfig, i as buildLmstudioAuthHeaders, j as LMSTUDIO_DOCKER_HOST_INFERENCE_BASE_URL, k as LMSTUDIO_DEFAULT_MODEL_ID, l as hasLmstudioAuthorizationHeader, m as mapLmstudioWireEntry, o as resolveLmstudioProviderHeaders, p as buildLmstudioModelName, r as fetchLmstudioModels, s as resolveLmstudioRequestContext, t as discoverLmstudioModels, u as resolveLmstudioProviderAuthMode, v as normalizeLmstudioProviderConfig, w as LMSTUDIO_DEFAULT_API_KEY_ENV_VAR, x as resolveLmstudioReasoningCompat, y as resolveLmstudioInferenceBase } from "../../models.fetch-BJryONkH.js";
//#region extensions/lmstudio/src/setup.ts
function isTruthyEnvValue(value) {
	return [
		"1",
		"true",
		"yes",
		"on"
	].includes(value?.trim().toLowerCase() ?? "");
}
function resolveLmstudioSetupDefaultBaseUrl(env = process.env) {
	return isTruthyEnvValue(env.OPENCLAW_DOCKER_SETUP) ? LMSTUDIO_DOCKER_HOST_BASE_URL : LMSTUDIO_DEFAULT_BASE_URL;
}
function resolveLmstudioSetupDefaultInferenceBaseUrl(env = process.env) {
	return isTruthyEnvValue(env.OPENCLAW_DOCKER_SETUP) ? LMSTUDIO_DOCKER_HOST_INFERENCE_BASE_URL : LMSTUDIO_DEFAULT_INFERENCE_BASE_URL;
}
function stripLmstudioStoredAuthConfig(cfg) {
	const { profiles: _profiles, order: _order, ...restAuth } = cfg.auth ?? {};
	const nextProfiles = Object.fromEntries(Object.entries(cfg.auth?.profiles ?? {}).filter(([, profile]) => profile.provider !== LMSTUDIO_PROVIDER_ID));
	const nextOrder = Object.fromEntries(Object.entries(cfg.auth?.order ?? {}).filter(([providerId]) => providerId !== LMSTUDIO_PROVIDER_ID));
	return {
		...cfg,
		auth: Object.keys(restAuth).length > 0 || Object.keys(nextProfiles).length > 0 || Object.keys(nextOrder).length > 0 ? {
			...restAuth,
			...Object.keys(nextProfiles).length > 0 ? { profiles: nextProfiles } : {},
			...Object.keys(nextOrder).length > 0 ? { order: nextOrder } : {}
		} : void 0
	};
}
function resolvePositiveInteger(value) {
	if (typeof value === "number" && Number.isFinite(value)) {
		const normalized = Math.floor(value);
		return normalized > 0 ? normalized : void 0;
	}
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	if (!trimmed || !/^\d+$/.test(trimmed)) return;
	const normalized = Number.parseInt(trimmed, 10);
	return Number.isFinite(normalized) && normalized > 0 ? normalized : void 0;
}
function buildLmstudioSetupProviderConfig(params) {
	const existingWithoutAuth = params.existingProvider ? (({ auth: _auth, apiKey: _apiKey, ...rest }) => rest)(params.existingProvider) : void 0;
	const sharedWithoutAuth = params.sharedProvider ? (({ auth: _auth, apiKey: _apiKey, ...rest }) => rest)(params.sharedProvider) : void 0;
	const resolvedAuth = resolveLmstudioProviderAuthMode(params.apiKey);
	return {
		...existingWithoutAuth,
		...sharedWithoutAuth,
		baseUrl: params.baseUrl,
		api: params.sharedProvider?.api ?? params.existingProvider?.api ?? "openai-completions",
		...resolvedAuth ? { auth: resolvedAuth } : {},
		...params.apiKey !== void 0 ? { apiKey: params.apiKey } : {},
		headers: params.headers,
		models: params.models
	};
}
function resolveLmstudioModelAdvertisedContextLimit(entry) {
	const raw = entry.max_context_length;
	if (raw === void 0 || !Number.isFinite(raw) || raw <= 0) return;
	return Math.floor(raw);
}
function applyModelContextTokensOverride(model, contextTokens) {
	return {
		...model,
		contextTokens,
		maxTokens: Math.min(model.maxTokens, contextTokens)
	};
}
function applyRequestedContextWindowToAllModels(params) {
	const requestedContextWindow = params.requestedContextWindow;
	if (!requestedContextWindow) return params.models;
	const contextLimitByModelId = new Map(params.discoveryModels.map((entry) => {
		const modelId = entry.key?.trim();
		if (!modelId) return null;
		return [modelId, resolveLmstudioModelAdvertisedContextLimit(entry)];
	}).filter((entry) => Boolean(entry)));
	return params.models.map((model) => applyModelContextTokensOverride(model, Math.min(requestedContextWindow, contextLimitByModelId.get(model.id) ?? requestedContextWindow)));
}
function resolveLmstudioDiscoveryFailure(params) {
	const { baseUrl, discovery } = params;
	if (!discovery.reachable) return {
		noteLines: [`LM Studio could not be reached at ${baseUrl}.`, "Start LM Studio (or run lms server start) and re-run setup."],
		reason: "LM Studio not reachable"
	};
	if (discovery.status !== void 0 && discovery.status >= 400) return {
		noteLines: [`LM Studio returned HTTP ${discovery.status} while listing models at ${baseUrl}.`, "Check the base URL and API key, then re-run setup."],
		reason: `LM Studio discovery failed (${discovery.status})`
	};
	if (!discovery.models.some((model) => model.type === "llm" && Boolean(model.key?.trim()))) return {
		noteLines: [`No LM Studio LLM models were found at ${baseUrl}.`, "Load at least one model in LM Studio (or run lms load), then re-run setup."],
		reason: "No LM Studio models found"
	};
	return null;
}
function resolvePersistedLmstudioApiKey(params) {
	if (params.explicitAuth === "api-key") {
		if (params.preferFallbackApiKey && params.fallbackApiKey !== void 0) return params.fallbackApiKey;
		if (resolveLmstudioProviderAuthMode(params.currentApiKey)) return params.currentApiKey;
		return params.fallbackApiKey;
	}
	return shouldUseLmstudioApiKeyPlaceholder({
		hasModels: params.hasModels,
		resolvedApiKey: params.currentApiKey,
		hasAuthorizationHeader: params.hasAuthorizationHeader
	}) ? LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER : void 0;
}
/** Keeps explicit model entries first and appends unique discovered entries. */
function mergeDiscoveredModels(params) {
	const explicitModels = Array.isArray(params.explicitModels) ? params.explicitModels : [];
	const discoveredModels = Array.isArray(params.discoveredModels) ? params.discoveredModels : [];
	if (explicitModels.length === 0) return discoveredModels;
	if (discoveredModels.length === 0) return explicitModels;
	const merged = [...explicitModels];
	const seen = new Set(explicitModels.map((model) => model.id.trim()).filter(Boolean));
	for (const model of discoveredModels) {
		const id = model.id.trim();
		if (!id || seen.has(id)) continue;
		seen.add(id);
		merged.push(model);
	}
	return merged;
}
async function discoverLmstudioProviderCatalog(params) {
	const baseUrl = resolveLmstudioInferenceBase(params.baseUrl);
	return {
		baseUrl,
		api: "openai-completions",
		models: await discoverLmstudioModels({
			baseUrl,
			apiKey: params.apiKey ?? "",
			headers: params.headers,
			quiet: params.quiet
		})
	};
}
function isLmstudioDiscoveryConfigResolutionError(error) {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes("models.providers.lmstudio.apiKey") || message.includes("models.providers.lmstudio.headers.");
}
/** Preserves existing allowlist metadata and appends discovered LM Studio model refs. */
function mergeDiscoveredLmstudioAllowlistEntries(params) {
	return withAgentModelAliases(params.existing, params.discoveredModels.map((model) => model.id.trim()).filter(Boolean).map((id) => `${LMSTUDIO_PROVIDER_ID}/${id}`));
}
function selectDefaultLmstudioModelId(discoveredModels) {
	const ids = discoveredModels.map((model) => model.id.trim()).filter(Boolean);
	if (ids.length === 0) return;
	return ids.includes("qwen/qwen3.5-9b") ? LMSTUDIO_DEFAULT_MODEL_ID : ids[0];
}
async function discoverLmstudioSetupModels(params) {
	const discovery = await fetchLmstudioModels({
		baseUrl: params.baseUrl,
		apiKey: params.apiKey,
		...params.headers ? { headers: params.headers } : {},
		timeoutMs: params.timeoutMs ?? 5e3
	});
	const failure = resolveLmstudioDiscoveryFailure({
		baseUrl: params.baseUrl,
		discovery
	});
	if (failure) return { failure };
	const models = mapLmstudioWireModelsToConfig(discovery.models);
	const defaultModelId = selectDefaultLmstudioModelId(models);
	return { value: {
		discovery,
		models,
		defaultModel: defaultModelId ? `${LMSTUDIO_PROVIDER_ID}/${defaultModelId}` : void 0,
		defaultModelId
	} };
}
/** Interactive LM Studio setup with connectivity and model-availability checks. */
async function promptAndConfigureLmstudioInteractive(params) {
	const promptText = params.prompter?.text ?? params.promptText;
	if (!promptText) throw new Error("LM Studio interactive setup requires a text prompter.");
	const note = params.prompter?.note ?? params.note;
	const defaultBaseUrl = resolveLmstudioSetupDefaultBaseUrl();
	const baseUrl = resolveLmstudioInferenceBase(await promptText({
		message: `LM Studio base URL`,
		initialValue: defaultBaseUrl,
		placeholder: defaultBaseUrl,
		validate: (value) => value?.trim() ? void 0 : "Required"
	}) ?? defaultBaseUrl);
	let credentialInput;
	let credentialMode;
	const implicitRefMode = params.allowSecretRefPrompt === false && !params.secretInputMode;
	const autoRefEnvKey = process.env[LMSTUDIO_DEFAULT_API_KEY_ENV_VAR]?.trim();
	const apiKey = params.prompter && implicitRefMode && autoRefEnvKey ? autoRefEnvKey : params.prompter ? await ensureApiKeyFromEnvOrPrompt({
		config: params.config,
		provider: LMSTUDIO_PROVIDER_ID,
		envLabel: LMSTUDIO_DEFAULT_API_KEY_ENV_VAR,
		promptMessage: `${LMSTUDIO_PROVIDER_LABEL} API key`,
		normalize: (value) => value.trim(),
		validate: () => void 0,
		prompter: params.prompter,
		secretInputMode: params.allowSecretRefPrompt === false ? params.secretInputMode ?? "plaintext" : params.secretInputMode,
		setCredential: async (apiKeyValue, mode) => {
			credentialInput = apiKeyValue;
			credentialMode = mode;
		}
	}) : (await promptText({
		message: `LM Studio API key`,
		placeholder: "sk-... (leave blank if auth is disabled)",
		validate: () => void 0
	}) ?? "").trim();
	const normalizedApiKey = normalizeOptionalSecretInput(apiKey);
	const credentialSource = credentialInput ?? (implicitRefMode && autoRefEnvKey ? `\${LM_API_TOKEN}` : apiKey);
	const credential = (params.prompter ? credentialMode === "ref" || hasConfiguredSecretInput(credentialSource) : normalizedApiKey !== void 0) ? params.prompter ? buildApiKeyCredential(LMSTUDIO_PROVIDER_ID, credentialSource, void 0, credentialMode ? { secretInputMode: credentialMode } : implicitRefMode && autoRefEnvKey ? { secretInputMode: "ref" } : void 0) : {
		type: "api_key",
		provider: LMSTUDIO_PROVIDER_ID,
		key: normalizedApiKey ?? apiKey
	} : void 0;
	const existingProvider = params.config.models?.providers?.[LMSTUDIO_PROVIDER_ID];
	const persistedHeaders = existingProvider?.headers;
	const resolvedHeaders = await resolveLmstudioProviderHeaders({
		config: params.config,
		env: process.env,
		headers: persistedHeaders
	});
	const hasAuthorizationHeader = hasLmstudioAuthorizationHeader(resolvedHeaders);
	const setupDiscovery = await discoverLmstudioSetupModels({
		baseUrl,
		apiKey: normalizedApiKey ?? (shouldUseLmstudioApiKeyPlaceholder({
			hasModels: true,
			resolvedApiKey: void 0,
			hasAuthorizationHeader
		}) ? "lmstudio-local" : void 0),
		...resolvedHeaders ? { headers: resolvedHeaders } : {},
		timeoutMs: 5e3
	});
	if ("failure" in setupDiscovery) {
		await note?.(setupDiscovery.failure.noteLines.join("\n"), "LM Studio");
		throw new WizardCancelledError(setupDiscovery.failure.reason);
	}
	let discoveredModels = setupDiscovery.value.models;
	if (params.prompter) {
		const requestedContextWindow = resolvePositiveInteger(await params.prompter.text({
			message: "Preferred context length to load LM Studio models with (optional)",
			placeholder: "e.g. 32768 (leave blank to skip)",
			validate: (value) => value?.trim() ? resolvePositiveInteger(value) ? void 0 : "Enter a positive integer token count" : void 0
		}));
		discoveredModels = applyRequestedContextWindowToAllModels({
			models: discoveredModels,
			discoveryModels: setupDiscovery.value.discovery.models,
			requestedContextWindow
		});
	}
	const allowlistEntries = mergeDiscoveredLmstudioAllowlistEntries({
		existing: params.config.agents?.defaults?.models,
		discoveredModels
	});
	const defaultModel = setupDiscovery.value.defaultModel;
	const persistedApiKey = resolvePersistedLmstudioApiKey({
		currentApiKey: normalizedApiKey ? existingProvider?.apiKey : void 0,
		explicitAuth: resolveLmstudioProviderAuthMode(normalizedApiKey),
		fallbackApiKey: normalizedApiKey ? "LM_API_TOKEN" : void 0,
		preferFallbackApiKey: true,
		hasModels: discoveredModels.length > 0,
		hasAuthorizationHeader
	}) ?? (normalizedApiKey ? "LM_API_TOKEN" : void 0);
	if (!credential) await removeProviderAuthProfilesWithLock({
		provider: LMSTUDIO_PROVIDER_ID,
		agentDir: params.agentDir
	});
	return {
		profiles: credential ? [{
			profileId: `${LMSTUDIO_PROVIDER_ID}:default`,
			credential
		}] : [],
		configPatch: {
			agents: { defaults: { models: allowlistEntries } },
			models: {
				mode: params.config.models?.mode ?? "merge",
				providers: { [LMSTUDIO_PROVIDER_ID]: buildLmstudioSetupProviderConfig({
					existingProvider,
					baseUrl,
					apiKey: persistedApiKey,
					headers: persistedHeaders,
					models: discoveredModels
				}) }
			}
		},
		defaultModel
	};
}
/** Non-interactive setup path backed by the shared self-hosted helper. */
async function configureLmstudioNonInteractive(ctx) {
	const customBaseUrl = normalizeOptionalSecretInput(ctx.opts.customBaseUrl);
	const baseUrl = resolveLmstudioInferenceBase(customBaseUrl || resolveLmstudioSetupDefaultInferenceBaseUrl());
	const normalizedCtx = customBaseUrl ? {
		...ctx,
		opts: {
			...ctx.opts,
			customBaseUrl: baseUrl
		}
	} : ctx;
	const configureShared = async (configureCtx) => await configureOpenAICompatibleSelfHostedProviderNonInteractive({
		ctx: configureCtx,
		providerId: LMSTUDIO_PROVIDER_ID,
		providerLabel: LMSTUDIO_PROVIDER_LABEL,
		defaultBaseUrl: resolveLmstudioSetupDefaultInferenceBaseUrl(),
		defaultApiKeyEnvVar: LMSTUDIO_DEFAULT_API_KEY_ENV_VAR,
		modelPlaceholder: LMSTUDIO_MODEL_PLACEHOLDER
	});
	const requestedModelId = normalizeOptionalSecretInput(normalizedCtx.opts.customModelId);
	const resolved = await normalizedCtx.resolveApiKey({
		provider: LMSTUDIO_PROVIDER_ID,
		flagValue: normalizeOptionalSecretInput(normalizedCtx.opts.lmstudioApiKey) ?? normalizeOptionalSecretInput(normalizedCtx.opts.customApiKey),
		flagName: normalizeOptionalSecretInput(normalizedCtx.opts.lmstudioApiKey) !== void 0 ? "--lmstudio-api-key" : "--custom-api-key",
		envVar: LMSTUDIO_DEFAULT_API_KEY_ENV_VAR,
		envVarName: LMSTUDIO_DEFAULT_API_KEY_ENV_VAR,
		required: false
	});
	const existingProvider = normalizedCtx.config.models?.providers?.[LMSTUDIO_PROVIDER_ID];
	const persistedHeaders = existingProvider?.headers;
	const resolvedHeaders = await resolveLmstudioProviderHeaders({
		config: normalizedCtx.config,
		env: process.env,
		headers: persistedHeaders
	});
	const hasAuthorizationHeader = hasLmstudioAuthorizationHeader(resolvedHeaders);
	const useHeaderOnlyAuth = hasAuthorizationHeader && (!resolved || resolved.source !== "flag");
	const setupDiscoveryApiKey = (useHeaderOnlyAuth ? void 0 : resolved?.key) ?? (shouldUseLmstudioApiKeyPlaceholder({
		hasModels: true,
		resolvedApiKey: void 0,
		hasAuthorizationHeader
	}) ? "lmstudio-local" : void 0);
	if (!setupDiscoveryApiKey && !hasAuthorizationHeader) {
		normalizedCtx.runtime.error(`LM Studio API key is required. Set ${LMSTUDIO_DEFAULT_API_KEY_ENV_VAR} or pass --lmstudio-api-key.`);
		normalizedCtx.runtime.exit(1);
		return null;
	}
	const setupDiscovery = await discoverLmstudioSetupModels({
		baseUrl,
		apiKey: setupDiscoveryApiKey,
		...resolvedHeaders ? { headers: resolvedHeaders } : {},
		timeoutMs: 5e3
	});
	if ("failure" in setupDiscovery) {
		normalizedCtx.runtime.error(setupDiscovery.failure.noteLines.join("\n"));
		normalizedCtx.runtime.exit(1);
		return null;
	}
	const discoveredModels = setupDiscovery.value.models;
	const selectedModelId = requestedModelId ?? setupDiscovery.value.defaultModelId;
	const selectedModel = selectedModelId ? discoveredModels.find((model) => model.id === selectedModelId) : void 0;
	if (!selectedModelId || !selectedModel) {
		const availableModels = discoveredModels.map((model) => model.id).join(", ");
		normalizedCtx.runtime.error(requestedModelId ? [`LM Studio model ${requestedModelId} was not found at ${baseUrl}.`, `Available models: ${availableModels}`].join("\n") : [`LM Studio did not expose a usable default model at ${baseUrl}.`, `Available models: ${availableModels || "(none)"}`].join("\n"));
		normalizedCtx.runtime.exit(1);
		return null;
	}
	if (useHeaderOnlyAuth) {
		await removeProviderAuthProfilesWithLock({
			provider: LMSTUDIO_PROVIDER_ID,
			agentDir: normalizedCtx.agentDir
		});
		const configWithoutStoredLmstudioAuth = stripLmstudioStoredAuthConfig(normalizedCtx.config);
		return applyProviderDefaultModel({
			...configWithoutStoredLmstudioAuth,
			models: {
				...configWithoutStoredLmstudioAuth.models,
				mode: configWithoutStoredLmstudioAuth.models?.mode ?? "merge",
				providers: {
					...configWithoutStoredLmstudioAuth.models?.providers,
					[LMSTUDIO_PROVIDER_ID]: buildLmstudioSetupProviderConfig({
						existingProvider,
						baseUrl,
						headers: persistedHeaders,
						models: discoveredModels
					})
				}
			}
		}, `${LMSTUDIO_PROVIDER_ID}/${selectedModelId}`);
	}
	const resolvedOrSynthetic = resolved ?? (setupDiscoveryApiKey ? {
		key: setupDiscoveryApiKey,
		source: "flag"
	} : null);
	if (!resolvedOrSynthetic) return null;
	const configured = await configureShared({
		...normalizedCtx,
		opts: {
			...normalizedCtx.opts,
			customModelId: selectedModelId
		},
		resolveApiKey: async () => resolvedOrSynthetic
	});
	if (!configured) return null;
	const sharedProvider = configured.models?.providers?.[LMSTUDIO_PROVIDER_ID];
	const resolvedSyntheticLocalKey = resolvedOrSynthetic.key === LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER;
	const persistedApiKey = resolvePersistedLmstudioApiKey({
		currentApiKey: resolvedSyntheticLocalKey ? void 0 : existingProvider?.apiKey,
		explicitAuth: resolveLmstudioProviderAuthMode(resolvedOrSynthetic.key),
		fallbackApiKey: resolvedSyntheticLocalKey ? LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER : configured.models?.providers?.["lmstudio"]?.apiKey ?? "LM_API_TOKEN",
		preferFallbackApiKey: true,
		hasModels: discoveredModels.length > 0,
		hasAuthorizationHeader: hasLmstudioAuthorizationHeader(resolvedHeaders)
	});
	return {
		...configured,
		models: {
			...configured.models,
			providers: {
				...configured.models?.providers,
				[LMSTUDIO_PROVIDER_ID]: buildLmstudioSetupProviderConfig({
					existingProvider,
					sharedProvider,
					baseUrl,
					apiKey: persistedApiKey,
					headers: persistedHeaders,
					models: discoveredModels
				})
			}
		}
	};
}
/** Discovers provider settings, merging explicit config with live model discovery. */
async function discoverLmstudioProvider(ctx) {
	const explicit = ctx.config.models?.providers?.[LMSTUDIO_PROVIDER_ID];
	const explicitAuth = explicit?.auth;
	let explicitWithoutHeaders;
	if (explicit) {
		const { headers: _headers, auth: _auth, apiKey: _apiKey, ...rest } = explicit;
		explicitWithoutHeaders = rest;
	}
	const hasExplicitModels = Array.isArray(explicit?.models) && explicit.models.length > 0;
	const { apiKey, discoveryApiKey } = ctx.resolveProviderApiKey(LMSTUDIO_PROVIDER_ID);
	let resolvedHeaders;
	try {
		resolvedHeaders = await resolveLmstudioProviderHeaders({
			config: ctx.config,
			env: ctx.env,
			headers: explicit?.headers
		});
	} catch (error) {
		if (isLmstudioDiscoveryConfigResolutionError(error)) return null;
		throw error;
	}
	const hasAuthorizationHeader = hasLmstudioAuthorizationHeader(resolvedHeaders);
	let configuredDiscoveryApiKey;
	try {
		configuredDiscoveryApiKey = await resolveLmstudioConfiguredApiKey({
			config: ctx.config,
			env: ctx.env,
			allowUnresolved: hasAuthorizationHeader || Boolean(discoveryApiKey)
		});
	} catch (error) {
		if (isLmstudioDiscoveryConfigResolutionError(error)) return null;
		throw error;
	}
	const resolvedDiscoveryApiKey = hasAuthorizationHeader ? void 0 : discoveryApiKey ?? configuredDiscoveryApiKey;
	const resolvedApiKey = apiKey ?? explicit?.apiKey;
	if (hasExplicitModels && explicitWithoutHeaders) {
		const persistedApiKey = resolvePersistedLmstudioApiKey({
			currentApiKey: resolvedApiKey,
			explicitAuth,
			fallbackApiKey: LMSTUDIO_DEFAULT_API_KEY_ENV_VAR,
			hasModels: hasExplicitModels,
			hasAuthorizationHeader
		});
		const persistedAuth = resolveLmstudioProviderAuthMode(persistedApiKey);
		return { provider: {
			...explicitWithoutHeaders,
			...resolvedHeaders ? { headers: resolvedHeaders } : {},
			baseUrl: resolveLmstudioInferenceBase(explicitWithoutHeaders.baseUrl),
			api: explicitWithoutHeaders.api ?? "openai-completions",
			...persistedApiKey ? { apiKey: persistedApiKey } : {},
			...persistedAuth ? { auth: persistedAuth } : {},
			models: explicitWithoutHeaders.models
		} };
	}
	const provider = await discoverLmstudioProviderCatalog({
		baseUrl: explicit?.baseUrl,
		apiKey: resolvedDiscoveryApiKey,
		headers: resolvedHeaders,
		quiet: !apiKey && !explicit && !resolvedDiscoveryApiKey
	});
	const models = mergeDiscoveredModels({
		explicitModels: explicit?.models,
		discoveredModels: provider.models
	});
	if (models.length === 0 && !apiKey && !explicit?.apiKey) return null;
	const persistedApiKey = resolvePersistedLmstudioApiKey({
		currentApiKey: resolvedApiKey,
		explicitAuth,
		fallbackApiKey: LMSTUDIO_DEFAULT_API_KEY_ENV_VAR,
		hasModels: models.length > 0,
		hasAuthorizationHeader
	});
	const persistedAuth = resolveLmstudioProviderAuthMode(persistedApiKey);
	return { provider: {
		...provider,
		...explicitWithoutHeaders,
		...resolvedHeaders ? { headers: resolvedHeaders } : {},
		baseUrl: resolveLmstudioInferenceBase(explicit?.baseUrl ?? provider.baseUrl),
		...persistedApiKey ? { apiKey: persistedApiKey } : {},
		...persistedAuth ? { auth: persistedAuth } : {},
		models
	} };
}
async function prepareLmstudioDynamicModels(ctx) {
	const baseUrl = resolveLmstudioInferenceBase(ctx.providerConfig?.baseUrl);
	const { apiKey, headers } = await resolveLmstudioRequestContext({
		config: ctx.config,
		agentDir: ctx.agentDir,
		env: process.env,
		providerHeaders: ctx.providerConfig?.headers
	});
	return (await discoverLmstudioModels({
		baseUrl,
		apiKey: apiKey ?? "",
		headers,
		quiet: true
	})).map((model) => Object.assign({}, model, {
		provider: LMSTUDIO_PROVIDER_ID,
		api: ctx.providerConfig?.api ?? `openai-completions`,
		baseUrl,
		input: model.input.filter((entry) => entry === "text" || entry === "image")
	}));
}
//#endregion
export { LMSTUDIO_DEFAULT_API_KEY_ENV_VAR, LMSTUDIO_DEFAULT_BASE_URL, LMSTUDIO_DEFAULT_EMBEDDING_MODEL, LMSTUDIO_DEFAULT_INFERENCE_BASE_URL, LMSTUDIO_DEFAULT_LOAD_CONTEXT_LENGTH, LMSTUDIO_DEFAULT_MODEL_ID, LMSTUDIO_DOCKER_HOST_BASE_URL, LMSTUDIO_DOCKER_HOST_INFERENCE_BASE_URL, LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER, LMSTUDIO_MODEL_PLACEHOLDER, LMSTUDIO_PROVIDER_ID, LMSTUDIO_PROVIDER_LABEL, buildLmstudioAuthHeaders, buildLmstudioModelName, configureLmstudioNonInteractive, discoverLmstudioProvider, mapLmstudioWireEntry, mapLmstudioWireModelsToConfig, normalizeLmstudioConfiguredCatalogEntries, normalizeLmstudioConfiguredCatalogEntry, normalizeLmstudioProviderConfig, prepareLmstudioDynamicModels, promptAndConfigureLmstudioInteractive, resolveLmstudioConfiguredApiKey, resolveLmstudioInferenceBase, resolveLmstudioProviderHeaders, resolveLmstudioReasoningCapability, resolveLmstudioReasoningCompat, resolveLmstudioRequestContext, resolveLmstudioRuntimeApiKey, resolveLmstudioServerBase, resolveLoadedContextWindow };
