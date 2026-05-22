import { c as normalizeOptionalString, d as normalizeStringifiedOptionalString } from "./string-coerce-LndEvhRk.js";
import { t as createSubsystemLogger } from "./subsystem-BIU8gc5f.js";
import { l as resolveAuthStorePath } from "./source-check-DuCLYDLT.js";
import { g as ensureAuthStoreFile, p as updateAuthProfileStoreWithLock } from "./store-B6VhslyM.js";
import { t as normalizeOptionalSecretInput } from "./normalize-secret-input-DWiNA0aw.js";
import { n as fetchWithSsrFGuard } from "./fetch-guard-C_JWdbr4.js";
import { t as applyAuthProfileConfig } from "./provider-auth-helpers-DtTI9enP.js";
//#region src/agents/auth-profiles/upsert-with-lock.ts
async function upsertAuthProfileWithLock(params) {
	ensureAuthStoreFile(resolveAuthStorePath(params.agentDir));
	try {
		return await updateAuthProfileStoreWithLock({
			agentDir: params.agentDir,
			updater: (store) => {
				store.profiles[params.profileId] = params.credential;
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
			return models.map((model) => ({ id: normalizeOptionalString(model.id) ?? "" })).filter((model) => Boolean(model.id)).map((model) => {
				const modelId = model.id;
				return {
					id: modelId,
					name: modelId,
					reasoning: isReasoningModelHeuristic(modelId),
					input: ["text"],
					cost: SELF_HOSTED_DEFAULT_COST,
					contextWindow: params.contextWindow ?? 128e3,
					maxTokens: params.maxTokens ?? 8192
				};
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
	if (params.ctx.config.models?.providers?.[params.providerId]) return null;
	const { apiKey, discoveryApiKey } = params.ctx.resolveProviderApiKey(params.providerId);
	if (!apiKey) return null;
	return { provider: {
		...await params.buildProvider({ apiKey: discoveryApiKey }),
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
