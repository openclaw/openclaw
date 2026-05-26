import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { r as normalizeProviderId } from "./provider-id-zTW9Rdln.js";
import { o as buildModelCatalogMergeKey, r as planManifestModelCatalogSuppressions } from "./model-catalog-DtQLR692.js";
import { n as isManifestPluginAvailableForControlPlane, s as loadManifestMetadataSnapshot } from "./manifest-contract-eligibility-LkT7g78Y.js";
//#region src/plugins/manifest-model-suppression.ts
function listManifestModelCatalogSuppressions(params) {
	const snapshot = loadManifestMetadataSnapshot({
		config: params.config,
		workspaceDir: params.workspaceDir,
		env: params.env
	});
	return planManifestModelCatalogSuppressions({ registry: {
		diagnostics: snapshot.diagnostics,
		plugins: snapshot.plugins.filter((plugin) => isManifestPluginAvailableForControlPlane({
			snapshot,
			plugin,
			config: params.config
		}))
	} }).suppressions;
}
function buildManifestSuppressionError(params) {
	const ref = `${params.provider}/${params.modelId}`;
	return params.reason ? `Unknown model: ${ref}. ${params.reason}` : `Unknown model: ${ref}.`;
}
function normalizeBaseUrlHost(baseUrl) {
	const trimmed = baseUrl?.trim();
	if (!trimmed) return "";
	try {
		return normalizeSuppressionHost(new URL(trimmed).hostname);
	} catch {
		return "";
	}
}
function normalizeSuppressionHost(host) {
	return normalizeLowercaseStringOrEmpty(host).replace(/\.+$/, "");
}
function resolveConfiguredProviderValue(params) {
	const providers = params.config?.models?.providers;
	if (!providers) return;
	for (const [providerId, entry] of Object.entries(providers)) {
		if (normalizeLowercaseStringOrEmpty(providerId) !== params.provider) continue;
		return {
			api: normalizeLowercaseStringOrEmpty(entry?.api),
			baseUrl: typeof entry?.baseUrl === "string" ? entry.baseUrl : void 0
		};
	}
}
function manifestSuppressionMatchesConditions(params) {
	const when = params.suppression.when;
	if (!when) return true;
	const configuredProvider = resolveConfiguredProviderValue({
		provider: params.provider,
		config: params.config
	});
	if (when.providerConfigApiIn?.length) {
		const allowedApis = new Set(when.providerConfigApiIn.map(normalizeLowercaseStringOrEmpty));
		const effectiveApi = configuredProvider ? normalizeLowercaseStringOrEmpty(configuredProvider.api) : params.provider;
		if (!effectiveApi || !allowedApis.has(effectiveApi)) return false;
	}
	if (when.baseUrlHosts?.length) {
		const baseUrlHost = normalizeBaseUrlHost(params.baseUrl ?? configuredProvider?.baseUrl);
		if (!baseUrlHost) return false;
		if (!new Set(when.baseUrlHosts.map(normalizeSuppressionHost)).has(baseUrlHost)) return false;
	}
	return true;
}
function buildManifestBuiltInModelSuppressionResolver(params) {
	const suppressions = listManifestModelCatalogSuppressions({
		config: params.config,
		workspaceDir: params.workspaceDir,
		env: params.env ?? process.env
	});
	return (input) => {
		const provider = normalizeLowercaseStringOrEmpty(input.provider);
		const modelId = normalizeLowercaseStringOrEmpty(input.id);
		if (!provider || !modelId) return;
		const mergeKey = buildModelCatalogMergeKey(provider, modelId);
		const suppression = suppressions.find((entry) => entry.mergeKey === mergeKey && (!input.unconditionalOnly || !entry.when) && manifestSuppressionMatchesConditions({
			suppression: entry,
			provider,
			baseUrl: input.baseUrl,
			config: params.config
		}));
		if (!suppression) return;
		return {
			suppress: true,
			errorMessage: buildManifestSuppressionError({
				provider,
				modelId,
				reason: suppression.reason
			})
		};
	};
}
/**
* Resolves whether a built-in model should be suppressed based on manifest declarations.
*
* Note: This function instantiates a fresh resolver on every call, which incurs a full
* filesystem scan of the manifest registry. For hot paths (like building the model catalog),
* instantiate and reuse `buildManifestBuiltInModelSuppressionResolver` instead.
*/
function resolveManifestBuiltInModelSuppression(params) {
	return buildManifestBuiltInModelSuppressionResolver({
		config: params.config,
		workspaceDir: params.workspaceDir,
		env: params.env
	})({
		provider: params.provider,
		id: params.id,
		baseUrl: params.baseUrl,
		unconditionalOnly: params.unconditionalOnly
	});
}
//#endregion
//#region src/agents/model-suppression.ts
function resolveBuiltInModelSuppressionFromManifest(params) {
	const provider = normalizeProviderId(params.provider ?? "");
	const modelId = normalizeLowercaseStringOrEmpty(params.id);
	if (!provider || !modelId) return;
	return resolveManifestBuiltInModelSuppression({
		provider,
		id: modelId,
		...params.config ? { config: params.config } : {},
		...params.baseUrl ? { baseUrl: params.baseUrl } : {},
		unconditionalOnly: params.unconditionalOnly,
		env: process.env
	});
}
function resolveBuiltInModelSuppression(params) {
	const manifestResult = resolveBuiltInModelSuppressionFromManifest(params);
	if (manifestResult?.suppress) return manifestResult;
	const provider = normalizeProviderId(params.provider ?? "");
	const modelId = normalizeLowercaseStringOrEmpty(params.id);
	if (!provider || !modelId) return;
}
function shouldSuppressBuiltInModelFromManifest(params) {
	return resolveBuiltInModelSuppressionFromManifest(params)?.suppress ?? false;
}
function shouldSuppressBuiltInModel(params) {
	return resolveBuiltInModelSuppression(params)?.suppress ?? false;
}
function shouldUnconditionallySuppress(params) {
	return resolveBuiltInModelSuppressionFromManifest({
		...params,
		unconditionalOnly: true
	})?.suppress ?? false;
}
function buildSuppressedBuiltInModelError(params) {
	return resolveBuiltInModelSuppression(params)?.errorMessage;
}
function buildShouldSuppressBuiltInModel(params) {
	const resolver = buildManifestBuiltInModelSuppressionResolver({
		config: params.config,
		env: process.env
	});
	return (input) => {
		const provider = normalizeProviderId(input.provider ?? "");
		const id = normalizeLowercaseStringOrEmpty(input.id);
		if (!provider || !id) return false;
		return resolver({
			...input,
			provider,
			id
		})?.suppress ?? false;
	};
}
//#endregion
export { shouldUnconditionallySuppress as a, shouldSuppressBuiltInModelFromManifest as i, buildSuppressedBuiltInModelError as n, shouldSuppressBuiltInModel as r, buildShouldSuppressBuiltInModel as t };
