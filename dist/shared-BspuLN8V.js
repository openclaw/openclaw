import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { n as buildApiKeyCredential, t as applyAuthProfileConfig } from "./provider-auth-helpers-BZ5Z8RV6.js";
import "./provider-auth-BtRKd5us.js";
//#region extensions/microsoft-foundry/shared.ts
const PROVIDER_ID = "microsoft-foundry";
const DEFAULT_API = "openai-completions";
const DEFAULT_GPT5_API = "openai-responses";
const COGNITIVE_SERVICES_RESOURCE = "https://cognitiveservices.azure.com";
const TOKEN_REFRESH_MARGIN_MS = 300 * 1e3;
function normalizeModelInput(input) {
	const normalized = Array.isArray(input) ? input.filter((item) => item === "text" || item === "image") : [];
	return normalized.length > 0 ? normalized : ["text"];
}
function normalizeFoundryModelName(value) {
	return normalizeLowercaseStringOrEmpty(value) || void 0;
}
function usesFoundryResponsesByDefault(value) {
	const normalized = normalizeFoundryModelName(value);
	if (!normalized) return false;
	return normalized.startsWith("gpt-") || normalized.startsWith("o1") || normalized.startsWith("o3") || normalized.startsWith("o4") || normalized === "computer-use-preview";
}
function supportsFoundryImageInput(value) {
	const normalized = normalizeFoundryModelName(value);
	if (!normalized) return false;
	return normalized.startsWith("gpt-") || normalized.startsWith("o1") || normalized.startsWith("o3") || normalized.startsWith("o4") || normalized === "computer-use-preview";
}
function requiresFoundryMaxCompletionTokens(value) {
	const normalized = normalizeFoundryModelName(value);
	if (!normalized) return false;
	return normalized.startsWith("gpt-5") || normalized.startsWith("o1") || normalized.startsWith("o3") || normalized.startsWith("o4");
}
function isFoundryProviderApi(value) {
	return value === "openai-completions" || value === "openai-responses";
}
function normalizeFoundryEndpoint(endpoint) {
	const trimmed = normalizeOptionalString(endpoint) ?? "";
	if (!trimmed) return trimmed;
	try {
		const parsed = new URL(trimmed);
		parsed.search = "";
		parsed.hash = "";
		const normalizedPath = parsed.pathname.replace(/\/openai(?:$|\/).*/i, "").replace(/\/+$/, "");
		return `${parsed.origin}${normalizedPath && normalizedPath !== "/" ? normalizedPath : ""}`;
	} catch {
		return trimmed.replace(/[?#].*$/, "").replace(/\/+$/, "").replace(/\/openai(?:$|\/).*/i, "");
	}
}
function buildFoundryV1BaseUrl(endpoint) {
	const base = normalizeFoundryEndpoint(endpoint);
	return base.endsWith("/openai/v1") ? base : `${base}/openai/v1`;
}
function resolveFoundryApi(modelId, modelNameHint, configuredApi) {
	if (isFoundryProviderApi(configuredApi)) return configuredApi;
	return usesFoundryResponsesByDefault(resolveConfiguredModelNameHint(modelId, modelNameHint)) ? DEFAULT_GPT5_API : DEFAULT_API;
}
function buildFoundryProviderBaseUrl(endpoint, _modelId, _modelNameHint, _configuredApi) {
	return buildFoundryV1BaseUrl(endpoint);
}
function extractFoundryEndpoint(baseUrl) {
	if (!baseUrl) return;
	try {
		return normalizeFoundryEndpoint(baseUrl);
	} catch {
		return;
	}
}
function buildFoundryModelCompat(modelId, modelNameHint, configuredApi) {
	const resolvedApi = resolveFoundryApi(modelId, modelNameHint, configuredApi);
	const needsMaxCompletionTokens = requiresFoundryMaxCompletionTokens(resolveConfiguredModelNameHint(modelId, modelNameHint));
	if (resolvedApi !== "openai-responses" && !needsMaxCompletionTokens) return;
	return {
		...resolvedApi === "openai-responses" ? { supportsStore: false } : {},
		maxTokensField: needsMaxCompletionTokens ? "max_completion_tokens" : "max_tokens"
	};
}
function resolveFoundryModelCapabilities(modelId, modelNameHint, configuredApi, existingInput) {
	const modelName = resolveConfiguredModelNameHint(modelId, modelNameHint) ?? modelId;
	const api = resolveFoundryApi(modelId, modelName, configuredApi);
	const normalizedInput = normalizeModelInput(existingInput);
	return {
		modelName,
		api,
		input: normalizedInput.includes("image") || supportsFoundryImageInput(modelName) ? ["text", "image"] : normalizedInput,
		compat: buildFoundryModelCompat(modelId, modelName, api)
	};
}
function resolveConfiguredModelNameHint(modelId, modelNameHint) {
	const trimmedName = normalizeOptionalString(modelNameHint) ?? "";
	if (trimmedName) return trimmedName;
	const trimmedId = normalizeOptionalString(modelId) ?? "";
	return trimmedId ? trimmedId : void 0;
}
function buildFoundryProviderConfig(endpoint, modelId, modelNameHint, options) {
	const runtimeApiKey = options?.authMethod === "api-key" ? options.apiKey : void 0;
	const isApiKeyAuth = options?.authMethod === "api-key";
	const deployments = options?.deployments?.length ? options.deployments : [{
		name: modelId,
		modelName: modelNameHint ?? void 0
	}];
	const resolvedApi = resolveFoundryApi(modelId, modelNameHint, options?.api);
	return {
		baseUrl: buildFoundryProviderBaseUrl(endpoint, modelId, modelNameHint, resolvedApi),
		api: resolvedApi,
		...isApiKeyAuth ? {
			authHeader: false,
			...runtimeApiKey !== void 0 ? {
				apiKey: runtimeApiKey,
				headers: { "api-key": runtimeApiKey }
			} : {}
		} : {},
		models: deployments.map((deployment) => {
			const capabilities = resolveFoundryModelCapabilities(deployment.name, deployment.modelName, deployment.api);
			return Object.assign({
				id: deployment.name,
				name: capabilities.modelName,
				api: capabilities.api,
				reasoning: false,
				input: capabilities.input,
				cost: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0
				},
				contextWindow: 128e3,
				maxTokens: 16384
			}, capabilities.compat ? { compat: capabilities.compat } : {});
		})
	};
}
function buildFoundryCredentialMetadata(params) {
	const resolvedApi = resolveFoundryApi(params.modelId, params.modelNameHint, params.api);
	const metadata = {
		authMethod: params.authMethod,
		endpoint: params.endpoint,
		modelId: params.modelId,
		api: resolvedApi
	};
	const modelName = resolveConfiguredModelNameHint(params.modelId, params.modelNameHint);
	if (modelName) metadata.modelName = modelName;
	if (params.subscriptionId) metadata.subscriptionId = params.subscriptionId;
	if (params.subscriptionName) metadata.subscriptionName = params.subscriptionName;
	if (params.tenantId) metadata.tenantId = params.tenantId;
	return metadata;
}
/**
* Build the plugins.allow patch so the provider is allowlisted when the
* config already gates plugins via a non-empty allow array.  Returns an
* empty object when no patch is needed (allowlist absent / already listed).
*/
function buildPluginsAllowPatch(currentAllow) {
	if (!Array.isArray(currentAllow) || currentAllow.length === 0) return {};
	if (currentAllow.includes("microsoft-foundry")) return {};
	return { plugins: { allow: [...currentAllow, PROVIDER_ID] } };
}
function buildFoundryAuthOrderPatch(params) {
	const nextOrder = [params.profileId, ...(params.currentProviderProfileIds ?? []).filter((profileId) => profileId !== params.profileId)];
	return { auth: { order: { [PROVIDER_ID]: nextOrder } } };
}
function listConfiguredFoundryProfileIds(config) {
	return Object.entries(config.auth?.profiles ?? {}).filter(([, profile]) => profile.provider === PROVIDER_ID).map(([profileId]) => profileId);
}
function buildFoundryAuthResult(params) {
	return {
		profiles: [{
			profileId: params.profileId,
			credential: buildApiKeyCredential(PROVIDER_ID, params.apiKey, buildFoundryCredentialMetadata({
				authMethod: params.authMethod,
				endpoint: params.endpoint,
				modelId: params.modelId,
				modelNameHint: params.modelNameHint,
				api: params.api,
				subscriptionId: params.subscriptionId,
				subscriptionName: params.subscriptionName,
				tenantId: params.tenantId
			}), params.secretInputMode ? { secretInputMode: params.secretInputMode } : void 0)
		}],
		configPatch: {
			...buildFoundryAuthOrderPatch({
				profileId: params.profileId,
				currentProviderProfileIds: params.currentProviderProfileIds
			}),
			models: { providers: { [PROVIDER_ID]: buildFoundryProviderConfig(params.endpoint, params.modelId, params.modelNameHint, {
				api: params.api,
				authMethod: params.authMethod,
				apiKey: params.apiKey,
				deployments: params.deployments
			}) } },
			...buildPluginsAllowPatch(params.currentPluginsAllow)
		},
		defaultModel: `${PROVIDER_ID}/${params.modelId}`,
		notes: params.notes
	};
}
function applyFoundryProfileBinding(config, profileId) {
	config.auth = applyAuthProfileConfig(config, {
		profileId,
		provider: PROVIDER_ID,
		mode: "api_key"
	}).auth;
}
function applyFoundryProviderConfig(config, providerConfig) {
	config.models ??= {};
	config.models.providers ??= {};
	config.models.providers[PROVIDER_ID] = providerConfig;
}
function resolveFoundryTargetProfileId(config) {
	const configuredProfiles = config.auth?.profiles ?? {};
	const configuredProfileEntries = Object.entries(configuredProfiles).filter(([, profile]) => {
		return profile.provider === PROVIDER_ID;
	});
	if (configuredProfileEntries.length === 0) return;
	return config.auth?.order?.["microsoft-foundry"]?.find((profileId) => normalizeOptionalString(profileId)) ?? (configuredProfileEntries.length === 1 ? configuredProfileEntries[0]?.[0] : void 0);
}
//#endregion
export { resolveFoundryModelCapabilities as _, TOKEN_REFRESH_MARGIN_MS as a, usesFoundryResponsesByDefault as b, buildFoundryAuthResult as c, isFoundryProviderApi as d, listConfiguredFoundryProfileIds as f, resolveFoundryApi as g, resolveConfiguredModelNameHint as h, PROVIDER_ID as i, buildFoundryProviderBaseUrl as l, requiresFoundryMaxCompletionTokens as m, DEFAULT_API as n, applyFoundryProfileBinding as o, normalizeFoundryEndpoint as p, DEFAULT_GPT5_API as r, applyFoundryProviderConfig as s, COGNITIVE_SERVICES_RESOURCE as t, extractFoundryEndpoint as u, resolveFoundryTargetProfileId as v, supportsFoundryImageInput as y };
