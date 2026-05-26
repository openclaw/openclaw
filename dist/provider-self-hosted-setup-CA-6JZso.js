import { c as normalizeOptionalString, d as normalizeStringifiedOptionalString } from "./string-coerce-DyL154ka.js";
import { n as findNormalizedProviderValue, r as normalizeProviderId } from "./provider-id-zTW9Rdln.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { r as resolveAuthStorePath } from "./path-resolve-C6Vj5eOM.js";
import { p as updateAuthProfileStoreWithLock } from "./store-BMQkMM4l.js";
import { t as ensureAuthStoreFile } from "./paths-DuwII6c5.js";
import { f as parseConfiguredModelVisibilityEntries } from "./model-selection-shared-ClxdEp4X.js";
import { n as normalizeSecretInput, t as normalizeOptionalSecretInput } from "./normalize-secret-input-CsdRhsMj.js";
import { n as fetchWithSsrFGuard } from "./fetch-guard-BEAbHb5H.js";
import { t as applyAuthProfileConfig } from "./provider-auth-helpers-BZ5Z8RV6.js";
//#region src/agents/auth-profiles/upsert-with-lock.ts
function normalizeAuthProfileCredential(credential) {
	if (credential.type === "api_key") {
		if (typeof credential.key !== "string") return credential;
		const { key: _key, ...rest } = credential;
		const key = normalizeSecretInput(credential.key);
		return {
			...rest,
			...key ? { key } : {}
		};
	}
	if (credential.type === "token") {
		if (typeof credential.token !== "string") return credential;
		const { token: _token, ...rest } = credential;
		const token = normalizeSecretInput(credential.token);
		return {
			...rest,
			...token ? { token } : {}
		};
	}
	return credential;
}
async function upsertAuthProfileWithLock(params) {
	ensureAuthStoreFile(resolveAuthStorePath(params.agentDir));
	try {
		const credential = normalizeAuthProfileCredential(params.credential);
		return await updateAuthProfileStoreWithLock({
			agentDir: params.agentDir,
			saveOptions: {
				filterExternalAuthProfiles: false,
				syncExternalCli: false
			},
			updater: (store) => {
				store.profiles[params.profileId] = credential;
				return true;
			}
		});
	} catch {
		return null;
	}
}
//#endregion
//#region src/agents/self-hosted-provider-defaults.ts
const SELF_HOSTED_DEFAULT_CONTEXT_WINDOW = 128e3;
const SELF_HOSTED_DEFAULT_MAX_TOKENS = 8192;
const SELF_HOSTED_DEFAULT_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
//#endregion
//#region src/plugins/provider-self-hosted-setup.ts
const log = createSubsystemLogger("plugins/self-hosted-provider-setup");
function isReasoningModelHeuristic(modelId) {
	return /r1|reasoning|think|reason/i.test(modelId);
}
const SELF_HOSTED_ALWAYS_BLOCKED_HOSTNAMES = new Set(["metadata.google.internal"]);
function buildSelfHostedBaseUrlSsrFPolicy(baseUrl) {
	try {
		const parsed = new URL(baseUrl.trim());
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
		if (SELF_HOSTED_ALWAYS_BLOCKED_HOSTNAMES.has(parsed.hostname.toLowerCase())) return;
		return {
			hostnameAllowlist: [parsed.hostname],
			allowPrivateNetwork: true
		};
	} catch {
		return;
	}
}
function readPositiveInteger(value) {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return;
	return Math.trunc(value);
}
function resolveLlamaCppPropsUrl(baseUrl, modelId) {
	const parsed = new URL(baseUrl);
	const pathname = parsed.pathname.replace(/\/+$/, "");
	parsed.pathname = `${(pathname.endsWith("/v1") ? pathname.slice(0, -3) || "/" : pathname).replace(/\/+$/, "")}/props`;
	parsed.search = "";
	parsed.hash = "";
	const normalizedModelId = normalizeOptionalString(modelId);
	if (normalizedModelId) {
		parsed.searchParams.set("model", normalizedModelId);
		parsed.searchParams.set("autoload", "false");
	}
	return parsed.toString();
}
async function discoverLlamaCppRuntimeContextTokens(params) {
	let url;
	try {
		url = resolveLlamaCppPropsUrl(params.baseUrl, params.modelId);
	} catch {
		return;
	}
	try {
		const trimmedApiKey = normalizeOptionalString(params.apiKey);
		const { response, release } = await fetchWithSsrFGuard({
			url,
			init: { headers: trimmedApiKey ? { Authorization: `Bearer ${trimmedApiKey}` } : void 0 },
			policy: buildSelfHostedBaseUrlSsrFPolicy(params.baseUrl),
			timeoutMs: 2500
		});
		try {
			if (!response.ok) return;
			const data = await response.json();
			return readPositiveInteger(data.default_generation_settings?.n_ctx) ?? readPositiveInteger(data.n_ctx);
		} finally {
			await release();
		}
	} catch {
		return;
	}
}
async function discoverOpenAICompatibleLocalModels(params) {
	const env = params.env ?? process.env;
	if (env.VITEST || env.NODE_ENV === "test") return [];
	const trimmedBaseUrl = params.baseUrl.trim().replace(/\/+$/, "");
	const url = `${trimmedBaseUrl}/models`;
	try {
		const trimmedApiKey = normalizeOptionalString(params.apiKey);
		const { response, release } = await fetchWithSsrFGuard({
			url,
			init: { headers: trimmedApiKey ? { Authorization: `Bearer ${trimmedApiKey}` } : void 0 },
			policy: buildSelfHostedBaseUrlSsrFPolicy(trimmedBaseUrl),
			timeoutMs: 5e3
		});
		try {
			if (!response.ok) {
				log.warn(`Failed to discover ${params.label} models: ${response.status}`);
				return [];
			}
			const models = (await response.json()).data ?? [];
			if (models.length === 0) {
				log.warn(`No ${params.label} models found on local instance`);
				return [];
			}
			const discoveredModels = models.flatMap((model) => {
				const modelId = normalizeOptionalString(model.id);
				if (!modelId) return [];
				return [{
					id: modelId,
					meta: model.meta
				}];
			});
			const runtimeContextTokensByModelId = /* @__PURE__ */ new Map();
			if (params.contextWindow === void 0) {
				const uniqueModelIds = [...new Set(discoveredModels.map((model) => model.id))];
				const runtimeContextTokenResults = await Promise.all(uniqueModelIds.map(async (modelId) => [modelId, await discoverLlamaCppRuntimeContextTokens({
					baseUrl: trimmedBaseUrl,
					apiKey: params.apiKey,
					modelId: uniqueModelIds.length > 1 ? modelId : void 0
				})]));
				for (const [modelId, runtimeContextTokens] of runtimeContextTokenResults) if (runtimeContextTokens) runtimeContextTokensByModelId.set(modelId, runtimeContextTokens);
			}
			return discoveredModels.map((model) => {
				const modelConfig = {
					id: model.id,
					name: model.id,
					reasoning: isReasoningModelHeuristic(model.id),
					input: ["text"],
					cost: SELF_HOSTED_DEFAULT_COST,
					contextWindow: params.contextWindow ?? readPositiveInteger(model.meta?.n_ctx_train) ?? 128e3,
					maxTokens: params.maxTokens ?? 8192
				};
				const runtimeContextTokens = runtimeContextTokensByModelId.get(model.id);
				if (runtimeContextTokens) modelConfig.contextTokens = runtimeContextTokens;
				return modelConfig;
			});
		} finally {
			await release();
		}
	} catch (error) {
		log.warn(`Failed to discover ${params.label} models: ${String(error)}`);
		return [];
	}
}
function applyProviderDefaultModel(cfg, modelRef) {
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
function buildOpenAICompatibleSelfHostedProviderConfig(params) {
	const modelRef = `${params.providerId}/${params.modelId}`;
	const profileId = `${params.providerId}:default`;
	return {
		config: {
			...params.cfg,
			models: {
				...params.cfg.models,
				mode: params.cfg.models?.mode ?? "merge",
				providers: {
					...params.cfg.models?.providers,
					[params.providerId]: {
						baseUrl: params.baseUrl,
						api: "openai-completions",
						apiKey: params.providerApiKey,
						models: [{
							id: params.modelId,
							name: params.modelId,
							reasoning: params.reasoning ?? false,
							input: params.input ?? ["text"],
							cost: SELF_HOSTED_DEFAULT_COST,
							contextWindow: params.contextWindow ?? 128e3,
							maxTokens: params.maxTokens ?? 8192
						}]
					}
				}
			}
		},
		modelId: params.modelId,
		modelRef,
		profileId
	};
}
function buildSelfHostedProviderAuthResult(result) {
	return {
		profiles: [{
			profileId: result.profileId,
			credential: result.credential
		}],
		configPatch: result.config,
		defaultModel: result.modelRef
	};
}
async function promptAndConfigureOpenAICompatibleSelfHostedProvider(params) {
	const baseUrlRaw = await params.prompter.text({
		message: `${params.providerLabel} base URL`,
		initialValue: params.defaultBaseUrl,
		placeholder: params.defaultBaseUrl,
		validate: (value) => value?.trim() ? void 0 : "Required"
	});
	const apiKeyRaw = await params.prompter.text({
		message: `${params.providerLabel} API key`,
		placeholder: "sk-... (or any non-empty string)",
		validate: (value) => value?.trim() ? void 0 : "Required",
		sensitive: true
	});
	const modelIdRaw = await params.prompter.text({
		message: `${params.providerLabel} model`,
		placeholder: params.modelPlaceholder,
		validate: (value) => value?.trim() ? void 0 : "Required"
	});
	const baseUrl = (baseUrlRaw ?? "").trim().replace(/\/+$/, "");
	const apiKey = normalizeStringifiedOptionalString(apiKeyRaw) ?? "";
	const modelId = normalizeStringifiedOptionalString(modelIdRaw) ?? "";
	const credential = {
		type: "api_key",
		provider: params.providerId,
		key: apiKey
	};
	const configured = buildOpenAICompatibleSelfHostedProviderConfig({
		cfg: params.cfg,
		providerId: params.providerId,
		baseUrl,
		providerApiKey: params.defaultApiKeyEnvVar,
		modelId,
		input: params.input,
		reasoning: params.reasoning,
		contextWindow: params.contextWindow,
		maxTokens: params.maxTokens
	});
	return {
		config: configured.config,
		credential,
		modelId: configured.modelId,
		modelRef: configured.modelRef,
		profileId: configured.profileId
	};
}
async function promptAndConfigureOpenAICompatibleSelfHostedProviderAuth(params) {
	return buildSelfHostedProviderAuthResult(await promptAndConfigureOpenAICompatibleSelfHostedProvider(params));
}
async function discoverOpenAICompatibleSelfHostedProvider(params) {
	const configuredProvider = findNormalizedProviderValue(params.ctx.config.models?.providers, params.providerId);
	const configuredBaseUrl = configuredProvider ? normalizeOptionalString(configuredProvider.baseUrl) : void 0;
	if (configuredProvider) {
		if (!parseConfiguredModelVisibilityEntries({ cfg: params.ctx.config }).providerWildcards.has(normalizeProviderId(params.providerId))) return null;
	}
	const { apiKey, discoveryApiKey } = params.ctx.resolveProviderApiKey(params.providerId);
	if (!apiKey) return null;
	return { provider: {
		...await params.buildProvider({
			apiKey: discoveryApiKey,
			...configuredBaseUrl ? { baseUrl: configuredBaseUrl } : {}
		}),
		apiKey
	} };
}
function buildMissingNonInteractiveModelIdMessage(params) {
	return [`Missing --custom-model-id for --auth-choice ${params.authChoice}.`, `Pass the ${params.providerLabel} model id to use, for example ${params.modelPlaceholder}.`].join("\n");
}
function buildSelfHostedProviderCredential(params) {
	return params.ctx.toApiKeyCredential({
		provider: params.providerId,
		resolved: params.resolved
	});
}
async function configureOpenAICompatibleSelfHostedProviderNonInteractive(params) {
	const baseUrl = (normalizeOptionalSecretInput(params.ctx.opts.customBaseUrl) ?? params.defaultBaseUrl).replace(/\/+$/, "");
	const modelId = normalizeOptionalSecretInput(params.ctx.opts.customModelId);
	if (!modelId) {
		params.ctx.runtime.error(buildMissingNonInteractiveModelIdMessage({
			authChoice: params.ctx.authChoice,
			providerLabel: params.providerLabel,
			modelPlaceholder: params.modelPlaceholder
		}));
		params.ctx.runtime.exit(1);
		return null;
	}
	const resolved = await params.ctx.resolveApiKey({
		provider: params.providerId,
		flagValue: normalizeOptionalSecretInput(params.ctx.opts.customApiKey),
		flagName: "--custom-api-key",
		envVar: params.defaultApiKeyEnvVar,
		envVarName: params.defaultApiKeyEnvVar
	});
	if (!resolved) return null;
	const credential = buildSelfHostedProviderCredential({
		ctx: params.ctx,
		providerId: params.providerId,
		resolved
	});
	if (!credential) return null;
	const configured = buildOpenAICompatibleSelfHostedProviderConfig({
		cfg: params.ctx.config,
		providerId: params.providerId,
		baseUrl,
		providerApiKey: params.defaultApiKeyEnvVar,
		modelId,
		input: params.input,
		reasoning: params.reasoning,
		contextWindow: params.contextWindow,
		maxTokens: params.maxTokens
	});
	await upsertAuthProfileWithLock({
		profileId: configured.profileId,
		credential,
		agentDir: params.ctx.agentDir
	});
	const withProfile = applyAuthProfileConfig(configured.config, {
		profileId: configured.profileId,
		provider: params.providerId,
		mode: "api_key"
	});
	params.ctx.runtime.log(`Default ${params.providerLabel} model: ${modelId}`);
	return applyProviderDefaultModel(withProfile, configured.modelRef);
}
//#endregion
export { promptAndConfigureOpenAICompatibleSelfHostedProvider as a, SELF_HOSTED_DEFAULT_COST as c, discoverOpenAICompatibleSelfHostedProvider as i, SELF_HOSTED_DEFAULT_MAX_TOKENS as l, configureOpenAICompatibleSelfHostedProviderNonInteractive as n, promptAndConfigureOpenAICompatibleSelfHostedProviderAuth as o, discoverOpenAICompatibleLocalModels as r, SELF_HOSTED_DEFAULT_CONTEXT_WINDOW as s, applyProviderDefaultModel as t };
