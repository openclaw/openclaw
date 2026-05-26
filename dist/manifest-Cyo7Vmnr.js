import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { i as openRootFileSync, n as matchRootFileOpenFailure } from "./root-file-jRMCpJW4.js";
import { c as isRecord } from "./utils-sBTEdeml.js";
import { t as isBlockedObjectKey } from "./prototype-keys-gIgii6VQ.js";
import { l as normalizeTrimmedStringList } from "./string-normalization-DiPHgdft.js";
import "./boundary-file-read-CBe_wA_B.js";
import { n as MANIFEST_KEY } from "./legacy-names-CuutNmLC.js";
import { a as normalizeModelCatalog, s as normalizeModelCatalogProviderId } from "./model-catalog-DtQLR692.js";
import { t as parseJsonWithJson5Fallback } from "./parse-json-compat-c3237LfJ.js";
import { t as normalizeManifestCommandAliases } from "./manifest-command-aliases-BaxKypWl.js";
import { r as createPluginCacheKey, t as PluginLruCache } from "./plugin-cache-primitives-DcK62VYf.js";
import fs from "node:fs";
import path from "node:path";
//#region src/plugins/manifest.ts
const PLUGIN_MANIFEST_FILENAME = "openclaw.plugin.json";
const PLUGIN_MANIFEST_FILENAMES = [PLUGIN_MANIFEST_FILENAME];
const MAX_PLUGIN_MANIFEST_BYTES = 256 * 1024;
const pluginManifestLoadCache = new PluginLruCache(512);
function normalizeStringListRecord(value) {
	if (!isRecord(value)) return;
	const normalized = Object.create(null);
	for (const [key, rawValues] of Object.entries(value)) {
		const providerId = normalizeOptionalString(key) ?? "";
		if (!providerId || isBlockedObjectKey(providerId)) continue;
		const values = normalizeTrimmedStringList(rawValues);
		if (values.length === 0) continue;
		normalized[providerId] = values;
	}
	return Object.keys(normalized).length > 0 ? normalized : void 0;
}
function normalizeStringRecord(value) {
	if (!isRecord(value)) return;
	const normalized = Object.create(null);
	for (const [rawKey, rawValue] of Object.entries(value)) {
		const key = normalizeOptionalString(rawKey) ?? "";
		const value = normalizeOptionalString(rawValue) ?? "";
		if (!key || isBlockedObjectKey(key) || !value) continue;
		normalized[key] = value;
	}
	return Object.keys(normalized).length > 0 ? normalized : void 0;
}
const MEDIA_UNDERSTANDING_CAPABILITIES = new Set([
	"image",
	"audio",
	"video"
]);
function normalizeMediaUnderstandingCapabilityRecord(value) {
	if (!isRecord(value)) return;
	const normalized = {};
	for (const [rawKey, rawValue] of Object.entries(value)) {
		if (!MEDIA_UNDERSTANDING_CAPABILITIES.has(rawKey)) continue;
		const model = normalizeOptionalString(rawValue);
		if (model) normalized[rawKey] = model;
	}
	return Object.keys(normalized).length > 0 ? normalized : void 0;
}
function normalizeMediaUnderstandingPriorityRecord(value) {
	if (!isRecord(value)) return;
	const normalized = {};
	for (const [rawKey, rawValue] of Object.entries(value)) {
		if (!MEDIA_UNDERSTANDING_CAPABILITIES.has(rawKey) || typeof rawValue !== "number" || !Number.isFinite(rawValue)) continue;
		normalized[rawKey] = rawValue;
	}
	return Object.keys(normalized).length > 0 ? normalized : void 0;
}
function normalizeMediaUnderstandingCapabilities(value) {
	const values = normalizeTrimmedStringList(value).filter((entry) => MEDIA_UNDERSTANDING_CAPABILITIES.has(entry));
	return values.length > 0 ? values : void 0;
}
function normalizeMediaUnderstandingNativeDocumentInputs(value) {
	const values = normalizeTrimmedStringList(value).filter((entry) => entry === "pdf");
	return values.length > 0 ? values : void 0;
}
function normalizeMediaUnderstandingProviderMetadata(value) {
	if (!isRecord(value)) return;
	const normalized = Object.create(null);
	for (const [rawProviderId, rawMetadata] of Object.entries(value)) {
		const providerId = normalizeOptionalString(rawProviderId) ?? "";
		if (!providerId || isBlockedObjectKey(providerId) || !isRecord(rawMetadata)) continue;
		const capabilities = normalizeMediaUnderstandingCapabilities(rawMetadata.capabilities);
		const defaultModels = normalizeMediaUnderstandingCapabilityRecord(rawMetadata.defaultModels);
		const autoPriority = normalizeMediaUnderstandingPriorityRecord(rawMetadata.autoPriority);
		const nativeDocumentInputs = normalizeMediaUnderstandingNativeDocumentInputs(rawMetadata.nativeDocumentInputs);
		const metadata = {
			...capabilities ? { capabilities } : {},
			...defaultModels ? { defaultModels } : {},
			...autoPriority ? { autoPriority } : {},
			...nativeDocumentInputs ? { nativeDocumentInputs } : {}
		};
		if (Object.keys(metadata).length > 0) normalized[providerId] = metadata;
	}
	return Object.keys(normalized).length > 0 ? normalized : void 0;
}
function normalizeProviderBaseUrlGuard(value) {
	if (!isRecord(value)) return;
	const provider = normalizeOptionalString(value.provider);
	const allowedBaseUrls = normalizeTrimmedStringList(value.allowedBaseUrls);
	if (!provider || allowedBaseUrls.length === 0) return;
	const defaultBaseUrl = normalizeOptionalString(value.defaultBaseUrl);
	return {
		provider,
		...defaultBaseUrl ? { defaultBaseUrl } : {},
		allowedBaseUrls
	};
}
function normalizeCapabilityProviderAuthSignals(value) {
	if (!Array.isArray(value)) return;
	const signals = [];
	for (const rawSignal of value) {
		if (!isRecord(rawSignal)) continue;
		const provider = normalizeOptionalString(rawSignal.provider);
		if (!provider) continue;
		const providerBaseUrl = normalizeProviderBaseUrlGuard(rawSignal.providerBaseUrl);
		signals.push({
			provider,
			...providerBaseUrl ? { providerBaseUrl } : {}
		});
	}
	return signals.length > 0 ? signals : void 0;
}
function normalizeCapabilityProviderModeConfigSignal(value) {
	if (!isRecord(value)) return;
	const path = normalizeOptionalString(value.path);
	const defaultValue = normalizeOptionalString(value.default);
	const allowed = normalizeTrimmedStringList(value.allowed);
	const disallowed = normalizeTrimmedStringList(value.disallowed);
	const signal = {
		...path ? { path } : {},
		...defaultValue ? { default: defaultValue } : {},
		...allowed.length > 0 ? { allowed } : {},
		...disallowed.length > 0 ? { disallowed } : {}
	};
	return Object.keys(signal).length > 0 ? signal : void 0;
}
function normalizeCapabilityProviderConfigSignals(value) {
	if (!Array.isArray(value)) return;
	const signals = [];
	for (const rawSignal of value) {
		if (!isRecord(rawSignal)) continue;
		const rootPath = normalizeOptionalString(rawSignal.rootPath);
		if (!rootPath) continue;
		const overlayPath = normalizeOptionalString(rawSignal.overlayPath);
		const required = normalizeTrimmedStringList(rawSignal.required);
		const requiredAny = normalizeTrimmedStringList(rawSignal.requiredAny);
		const mode = normalizeCapabilityProviderModeConfigSignal(rawSignal.mode);
		const signal = {
			rootPath,
			...overlayPath ? { overlayPath } : {},
			...required.length > 0 ? { required } : {},
			...requiredAny.length > 0 ? { requiredAny } : {},
			...mode ? { mode } : {}
		};
		if (required.length > 0 || requiredAny.length > 0 || mode) signals.push(signal);
	}
	return signals.length > 0 ? signals : void 0;
}
function normalizeCapabilityProviderMetadataEntry(rawMetadata) {
	const aliases = normalizeTrimmedStringList(rawMetadata.aliases);
	const authProviders = normalizeTrimmedStringList(rawMetadata.authProviders);
	const authSignals = normalizeCapabilityProviderAuthSignals(rawMetadata.authSignals);
	const configSignals = normalizeCapabilityProviderConfigSignals(rawMetadata.configSignals);
	const referenceAudioInputs = rawMetadata.referenceAudioInputs === true ? true : void 0;
	const metadata = {
		...aliases.length > 0 ? { aliases } : {},
		...authProviders.length > 0 ? { authProviders } : {},
		...authSignals ? { authSignals } : {},
		...configSignals ? { configSignals } : {},
		...referenceAudioInputs ? { referenceAudioInputs } : {}
	};
	return Object.keys(metadata).length > 0 ? metadata : void 0;
}
function normalizeCapabilityProviderMetadata(value) {
	if (!isRecord(value)) return;
	const normalized = Object.create(null);
	for (const [rawProviderId, rawMetadata] of Object.entries(value)) {
		const providerId = normalizeOptionalString(rawProviderId) ?? "";
		if (!providerId || isBlockedObjectKey(providerId) || !isRecord(rawMetadata)) continue;
		const metadata = normalizeCapabilityProviderMetadataEntry(rawMetadata);
		if (metadata) normalized[providerId] = metadata;
	}
	return Object.keys(normalized).length > 0 ? normalized : void 0;
}
function normalizePluginToolMetadata(value) {
	if (!isRecord(value)) return;
	const normalized = Object.create(null);
	for (const [rawToolName, rawMetadata] of Object.entries(value)) {
		const toolName = normalizeOptionalString(rawToolName) ?? "";
		if (!toolName || isBlockedObjectKey(toolName) || !isRecord(rawMetadata)) continue;
		const metadata = {
			...normalizeCapabilityProviderMetadataEntry(rawMetadata),
			...rawMetadata.optional === true ? { optional: true } : {}
		};
		if (Object.keys(metadata).length > 0) normalized[toolName] = metadata;
	}
	return Object.keys(normalized).length > 0 ? normalized : void 0;
}
function normalizeManifestContracts(value) {
	if (!isRecord(value)) return;
	const embeddedExtensionFactories = normalizeTrimmedStringList(value.embeddedExtensionFactories);
	const agentToolResultMiddleware = normalizeTrimmedStringList(value.agentToolResultMiddleware);
	const externalAuthProviders = normalizeTrimmedStringList(value.externalAuthProviders);
	const embeddingProviders = normalizeTrimmedStringList(value.embeddingProviders);
	const memoryEmbeddingProviders = normalizeTrimmedStringList(value.memoryEmbeddingProviders);
	const speechProviders = normalizeTrimmedStringList(value.speechProviders);
	const realtimeTranscriptionProviders = normalizeTrimmedStringList(value.realtimeTranscriptionProviders);
	const realtimeVoiceProviders = normalizeTrimmedStringList(value.realtimeVoiceProviders);
	const mediaUnderstandingProviders = normalizeTrimmedStringList(value.mediaUnderstandingProviders);
	const documentExtractors = normalizeTrimmedStringList(value.documentExtractors);
	const imageGenerationProviders = normalizeTrimmedStringList(value.imageGenerationProviders);
	const videoGenerationProviders = normalizeTrimmedStringList(value.videoGenerationProviders);
	const musicGenerationProviders = normalizeTrimmedStringList(value.musicGenerationProviders);
	const webContentExtractors = normalizeTrimmedStringList(value.webContentExtractors);
	const webFetchProviders = normalizeTrimmedStringList(value.webFetchProviders);
	const webSearchProviders = normalizeTrimmedStringList(value.webSearchProviders);
	const migrationProviders = normalizeTrimmedStringList(value.migrationProviders);
	const gatewayMethodDispatch = normalizeTrimmedStringList(value.gatewayMethodDispatch);
	const tools = normalizeTrimmedStringList(value.tools);
	const contracts = {
		...embeddedExtensionFactories.length > 0 ? { embeddedExtensionFactories } : {},
		...agentToolResultMiddleware.length > 0 ? { agentToolResultMiddleware } : {},
		...externalAuthProviders.length > 0 ? { externalAuthProviders } : {},
		...embeddingProviders.length > 0 ? { embeddingProviders } : {},
		...memoryEmbeddingProviders.length > 0 ? { memoryEmbeddingProviders } : {},
		...speechProviders.length > 0 ? { speechProviders } : {},
		...realtimeTranscriptionProviders.length > 0 ? { realtimeTranscriptionProviders } : {},
		...realtimeVoiceProviders.length > 0 ? { realtimeVoiceProviders } : {},
		...mediaUnderstandingProviders.length > 0 ? { mediaUnderstandingProviders } : {},
		...documentExtractors.length > 0 ? { documentExtractors } : {},
		...imageGenerationProviders.length > 0 ? { imageGenerationProviders } : {},
		...videoGenerationProviders.length > 0 ? { videoGenerationProviders } : {},
		...musicGenerationProviders.length > 0 ? { musicGenerationProviders } : {},
		...webContentExtractors.length > 0 ? { webContentExtractors } : {},
		...webFetchProviders.length > 0 ? { webFetchProviders } : {},
		...webSearchProviders.length > 0 ? { webSearchProviders } : {},
		...migrationProviders.length > 0 ? { migrationProviders } : {},
		...gatewayMethodDispatch.length > 0 ? { gatewayMethodDispatch } : {},
		...tools.length > 0 ? { tools } : {}
	};
	return Object.keys(contracts).length > 0 ? contracts : void 0;
}
function isManifestConfigLiteral(value) {
	return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}
function normalizeManifestDangerousConfigFlags(value) {
	if (!Array.isArray(value)) return;
	const normalized = [];
	for (const entry of value) {
		if (!isRecord(entry)) continue;
		const path = normalizeOptionalString(entry.path) ?? "";
		if (!path || !isManifestConfigLiteral(entry.equals)) continue;
		normalized.push({
			path,
			equals: entry.equals
		});
	}
	return normalized.length > 0 ? normalized : void 0;
}
function normalizeManifestSecretInputPaths(value) {
	if (!Array.isArray(value)) return;
	const normalized = [];
	for (const entry of value) {
		if (!isRecord(entry)) continue;
		const path = normalizeOptionalString(entry.path) ?? "";
		if (!path) continue;
		const expected = entry.expected === "string" ? entry.expected : void 0;
		normalized.push({
			path,
			...expected ? { expected } : {}
		});
	}
	return normalized.length > 0 ? normalized : void 0;
}
function normalizeManifestConfigContracts(value) {
	if (!isRecord(value)) return;
	const compatibilityMigrationPaths = normalizeTrimmedStringList(value.compatibilityMigrationPaths);
	const compatibilityRuntimePaths = normalizeTrimmedStringList(value.compatibilityRuntimePaths);
	const rawSecretInputs = isRecord(value.secretInputs) ? value.secretInputs : void 0;
	const dangerousFlags = normalizeManifestDangerousConfigFlags(value.dangerousFlags);
	const secretInputPaths = rawSecretInputs ? normalizeManifestSecretInputPaths(rawSecretInputs.paths) : void 0;
	const secretInputs = secretInputPaths && secretInputPaths.length > 0 ? {
		...rawSecretInputs?.bundledDefaultEnabled === true ? { bundledDefaultEnabled: true } : rawSecretInputs?.bundledDefaultEnabled === false ? { bundledDefaultEnabled: false } : {},
		paths: secretInputPaths
	} : void 0;
	const configContracts = {
		...compatibilityMigrationPaths.length > 0 ? { compatibilityMigrationPaths } : {},
		...compatibilityRuntimePaths.length > 0 ? { compatibilityRuntimePaths } : {},
		...dangerousFlags ? { dangerousFlags } : {},
		...secretInputs ? { secretInputs } : {}
	};
	return Object.keys(configContracts).length > 0 ? configContracts : void 0;
}
function normalizeManifestModelSupport(value) {
	if (!isRecord(value)) return;
	const modelPrefixes = normalizeTrimmedStringList(value.modelPrefixes);
	const modelPatterns = normalizeTrimmedStringList(value.modelPatterns);
	const modelSupport = {
		...modelPrefixes.length > 0 ? { modelPrefixes } : {},
		...modelPatterns.length > 0 ? { modelPatterns } : {}
	};
	return Object.keys(modelSupport).length > 0 ? modelSupport : void 0;
}
function normalizeManifestModelPricingSource(value) {
	if (value === false) return false;
	if (!isRecord(value)) return;
	const provider = normalizeModelCatalogProviderId(normalizeOptionalString(value.provider) ?? "");
	const modelIdTransforms = normalizeTrimmedStringList(value.modelIdTransforms).filter((entry) => entry === "version-dots");
	const source = {
		...provider ? { provider } : {},
		...value.passthroughProviderModel === true ? { passthroughProviderModel: true } : {},
		...modelIdTransforms.length > 0 ? { modelIdTransforms } : {}
	};
	return Object.keys(source).length > 0 ? source : void 0;
}
function normalizeManifestModelPricingProvider(value) {
	if (!isRecord(value)) return;
	const openRouter = normalizeManifestModelPricingSource(value.openRouter);
	const liteLLM = normalizeManifestModelPricingSource(value.liteLLM);
	const policy = {
		...typeof value.external === "boolean" ? { external: value.external } : {},
		...openRouter !== void 0 ? { openRouter } : {},
		...liteLLM !== void 0 ? { liteLLM } : {}
	};
	return Object.keys(policy).length > 0 ? policy : void 0;
}
function normalizeManifestModelPricing(value, params) {
	if (!isRecord(value) || !isRecord(value.providers)) return;
	const ownedProviders = new Set([...params.ownedProviders].map((provider) => normalizeModelCatalogProviderId(provider)).filter(Boolean));
	const providers = {};
	for (const [rawProviderId, rawPolicy] of Object.entries(value.providers)) {
		const providerId = normalizeModelCatalogProviderId(rawProviderId);
		if (!providerId || !ownedProviders.has(providerId)) continue;
		const policy = normalizeManifestModelPricingProvider(rawPolicy);
		if (policy) providers[providerId] = policy;
	}
	return Object.keys(providers).length > 0 ? { providers } : void 0;
}
function normalizeManifestModelIdPrefixRules(value) {
	if (!Array.isArray(value)) return;
	const rules = [];
	for (const rawRule of value) {
		if (!isRecord(rawRule)) continue;
		const modelPrefix = normalizeOptionalString(rawRule.modelPrefix);
		const prefix = normalizeOptionalString(rawRule.prefix);
		if (!modelPrefix || !prefix) continue;
		rules.push({
			modelPrefix,
			prefix
		});
	}
	return rules.length > 0 ? rules : void 0;
}
function normalizeManifestModelIdNormalizationProvider(value) {
	if (!isRecord(value)) return;
	const aliases = {};
	if (isRecord(value.aliases)) for (const [rawAlias, rawCanonical] of Object.entries(value.aliases)) {
		const alias = normalizeModelCatalogProviderId(rawAlias);
		const canonical = normalizeOptionalString(rawCanonical);
		if (alias && canonical) aliases[alias] = canonical;
	}
	const stripPrefixes = normalizeTrimmedStringList(value.stripPrefixes);
	const prefixWhenBare = normalizeOptionalString(value.prefixWhenBare);
	const prefixWhenBareAfterAliasStartsWith = normalizeManifestModelIdPrefixRules(value.prefixWhenBareAfterAliasStartsWith);
	const normalization = {
		...Object.keys(aliases).length > 0 ? { aliases } : {},
		...stripPrefixes.length > 0 ? { stripPrefixes } : {},
		...prefixWhenBare ? { prefixWhenBare } : {},
		...prefixWhenBareAfterAliasStartsWith ? { prefixWhenBareAfterAliasStartsWith } : {}
	};
	return Object.keys(normalization).length > 0 ? normalization : void 0;
}
function normalizeManifestModelIdNormalization(value, params) {
	if (!isRecord(value) || !isRecord(value.providers)) return;
	const ownedProviders = new Set([...params.ownedProviders].map((provider) => normalizeModelCatalogProviderId(provider)).filter(Boolean));
	const providers = {};
	for (const [rawProviderId, rawPolicy] of Object.entries(value.providers)) {
		const providerId = normalizeModelCatalogProviderId(rawProviderId);
		if (!providerId || !ownedProviders.has(providerId)) continue;
		const policy = normalizeManifestModelIdNormalizationProvider(rawPolicy);
		if (policy) providers[providerId] = policy;
	}
	return Object.keys(providers).length > 0 ? { providers } : void 0;
}
function normalizeManifestProviderEndpoints(value) {
	if (!Array.isArray(value)) return;
	const endpoints = [];
	for (const rawEndpoint of value) {
		if (!isRecord(rawEndpoint)) continue;
		const endpointClass = normalizeOptionalString(rawEndpoint.endpointClass);
		if (!endpointClass) continue;
		const hosts = normalizeTrimmedStringList(rawEndpoint.hosts).map((host) => host.toLowerCase());
		const hostSuffixes = normalizeTrimmedStringList(rawEndpoint.hostSuffixes).map((host) => host.toLowerCase());
		const baseUrls = normalizeTrimmedStringList(rawEndpoint.baseUrls);
		const googleVertexRegion = normalizeOptionalString(rawEndpoint.googleVertexRegion);
		const googleVertexRegionHostSuffix = normalizeOptionalString(rawEndpoint.googleVertexRegionHostSuffix)?.toLowerCase();
		if (hosts.length === 0 && hostSuffixes.length === 0 && baseUrls.length === 0) continue;
		endpoints.push({
			endpointClass,
			...hosts.length > 0 ? { hosts } : {},
			...hostSuffixes.length > 0 ? { hostSuffixes } : {},
			...baseUrls.length > 0 ? { baseUrls } : {},
			...googleVertexRegion ? { googleVertexRegion } : {},
			...googleVertexRegionHostSuffix ? { googleVertexRegionHostSuffix } : {}
		});
	}
	return endpoints.length > 0 ? endpoints : void 0;
}
function normalizeManifestProviderRequestProvider(value) {
	if (!isRecord(value)) return;
	const family = normalizeOptionalString(value.family);
	const compatibilityFamily = normalizeOptionalString(value.compatibilityFamily) === "moonshot" ? "moonshot" : void 0;
	const supportsStreamingUsage = isRecord(value.openAICompletions) ? value.openAICompletions.supportsStreamingUsage : void 0;
	const openAICompletions = typeof supportsStreamingUsage === "boolean" ? { supportsStreamingUsage } : void 0;
	const providerRequest = {
		...family ? { family } : {},
		...compatibilityFamily ? { compatibilityFamily } : {},
		...openAICompletions && Object.keys(openAICompletions).length > 0 ? { openAICompletions } : {}
	};
	return Object.keys(providerRequest).length > 0 ? providerRequest : void 0;
}
function normalizeManifestProviderRequest(value, params) {
	if (!isRecord(value) || !isRecord(value.providers)) return;
	const ownedProviders = new Set([...params.ownedProviders].map((provider) => normalizeModelCatalogProviderId(provider)).filter(Boolean));
	const providers = {};
	for (const [rawProviderId, rawPolicy] of Object.entries(value.providers)) {
		const providerId = normalizeModelCatalogProviderId(rawProviderId);
		if (!providerId || !ownedProviders.has(providerId)) continue;
		const policy = normalizeManifestProviderRequestProvider(rawPolicy);
		if (policy) providers[providerId] = policy;
	}
	return Object.keys(providers).length > 0 ? { providers } : void 0;
}
function normalizeManifestActivation(value) {
	if (!isRecord(value)) return;
	const onProviders = normalizeTrimmedStringList(value.onProviders);
	const onAgentHarnesses = normalizeTrimmedStringList(value.onAgentHarnesses);
	const onCommands = normalizeTrimmedStringList(value.onCommands);
	const onChannels = normalizeTrimmedStringList(value.onChannels);
	const onRoutes = normalizeTrimmedStringList(value.onRoutes);
	const onConfigPaths = normalizeTrimmedStringList(value.onConfigPaths);
	const onStartup = typeof value.onStartup === "boolean" ? value.onStartup : void 0;
	const onCapabilities = normalizeTrimmedStringList(value.onCapabilities).filter((capability) => capability === "provider" || capability === "channel" || capability === "tool" || capability === "hook");
	const activation = {
		...onStartup !== void 0 ? { onStartup } : {},
		...onProviders.length > 0 ? { onProviders } : {},
		...onAgentHarnesses.length > 0 ? { onAgentHarnesses } : {},
		...onCommands.length > 0 ? { onCommands } : {},
		...onChannels.length > 0 ? { onChannels } : {},
		...onRoutes.length > 0 ? { onRoutes } : {},
		...onConfigPaths.length > 0 ? { onConfigPaths } : {},
		...onCapabilities.length > 0 ? { onCapabilities } : {}
	};
	return Object.keys(activation).length > 0 ? activation : void 0;
}
const MANIFEST_DEFAULT_ENABLEMENT_PLATFORMS = new Set([
	"aix",
	"android",
	"darwin",
	"freebsd",
	"haiku",
	"linux",
	"openbsd",
	"sunos",
	"win32",
	"cygwin",
	"netbsd"
]);
function normalizeManifestDefaultPlatforms(value) {
	return normalizeTrimmedStringList(value).filter((platform) => MANIFEST_DEFAULT_ENABLEMENT_PLATFORMS.has(platform));
}
function normalizeManifestSetupProviders(value) {
	if (!Array.isArray(value)) return;
	const normalized = [];
	for (const entry of value) {
		if (!isRecord(entry)) continue;
		const id = normalizeOptionalString(entry.id) ?? "";
		if (!id) continue;
		const authMethods = normalizeTrimmedStringList(entry.authMethods);
		const envVars = normalizeTrimmedStringList(entry.envVars);
		const authEvidence = normalizeManifestSetupProviderAuthEvidence(entry.authEvidence);
		normalized.push({
			id,
			...authMethods.length > 0 ? { authMethods } : {},
			...envVars.length > 0 ? { envVars } : {},
			...authEvidence ? { authEvidence } : {}
		});
	}
	return normalized.length > 0 ? normalized : void 0;
}
function normalizeManifestSetupProviderAuthEvidence(value) {
	if (!Array.isArray(value)) return;
	const normalized = [];
	for (const entry of value) {
		if (!isRecord(entry) || entry.type !== "local-file-with-env") continue;
		const credentialMarker = normalizeOptionalString(entry.credentialMarker);
		if (!credentialMarker) continue;
		const fileEnvVar = normalizeOptionalString(entry.fileEnvVar);
		const fallbackPaths = normalizeTrimmedStringList(entry.fallbackPaths);
		if (!fileEnvVar && fallbackPaths.length === 0) continue;
		const requiresAnyEnv = normalizeTrimmedStringList(entry.requiresAnyEnv);
		const requiresAllEnv = normalizeTrimmedStringList(entry.requiresAllEnv);
		const source = normalizeOptionalString(entry.source);
		normalized.push({
			type: "local-file-with-env",
			...fileEnvVar ? { fileEnvVar } : {},
			...fallbackPaths.length > 0 ? { fallbackPaths } : {},
			...requiresAnyEnv.length > 0 ? { requiresAnyEnv } : {},
			...requiresAllEnv.length > 0 ? { requiresAllEnv } : {},
			credentialMarker,
			...source ? { source } : {}
		});
	}
	return normalized.length > 0 ? normalized : void 0;
}
function normalizeManifestSetup(value) {
	if (!isRecord(value)) return;
	const providers = normalizeManifestSetupProviders(value.providers);
	const cliBackends = normalizeTrimmedStringList(value.cliBackends);
	const configMigrations = normalizeTrimmedStringList(value.configMigrations);
	const requiresRuntime = typeof value.requiresRuntime === "boolean" ? value.requiresRuntime : void 0;
	const setup = {
		...providers ? { providers } : {},
		...cliBackends.length > 0 ? { cliBackends } : {},
		...configMigrations.length > 0 ? { configMigrations } : {},
		...requiresRuntime !== void 0 ? { requiresRuntime } : {}
	};
	return Object.keys(setup).length > 0 ? setup : void 0;
}
function normalizeManifestQaRunners(value) {
	if (!Array.isArray(value)) return;
	const normalized = [];
	for (const entry of value) {
		if (!isRecord(entry)) continue;
		const commandName = normalizeOptionalString(entry.commandName) ?? "";
		if (!commandName) continue;
		const description = normalizeOptionalString(entry.description) ?? "";
		normalized.push({
			commandName,
			...description ? { description } : {}
		});
	}
	return normalized.length > 0 ? normalized : void 0;
}
function normalizeProviderAuthChoices(value) {
	if (!Array.isArray(value)) return;
	const normalized = [];
	for (const entry of value) {
		if (!isRecord(entry)) continue;
		const provider = normalizeOptionalString(entry.provider) ?? "";
		const method = normalizeOptionalString(entry.method) ?? "";
		const choiceId = normalizeOptionalString(entry.choiceId) ?? "";
		if (!provider || !method || !choiceId) continue;
		const choiceLabel = normalizeOptionalString(entry.choiceLabel) ?? "";
		const choiceHint = normalizeOptionalString(entry.choiceHint) ?? "";
		const assistantPriority = typeof entry.assistantPriority === "number" && Number.isFinite(entry.assistantPriority) ? entry.assistantPriority : void 0;
		const assistantVisibility = entry.assistantVisibility === "manual-only" || entry.assistantVisibility === "visible" ? entry.assistantVisibility : void 0;
		const deprecatedChoiceIds = normalizeTrimmedStringList(entry.deprecatedChoiceIds);
		const groupId = normalizeOptionalString(entry.groupId) ?? "";
		const groupLabel = normalizeOptionalString(entry.groupLabel) ?? "";
		const groupHint = normalizeOptionalString(entry.groupHint) ?? "";
		const onboardingFeatured = entry.onboardingFeatured === true;
		const optionKey = normalizeOptionalString(entry.optionKey) ?? "";
		const cliFlag = normalizeOptionalString(entry.cliFlag) ?? "";
		const cliOption = normalizeOptionalString(entry.cliOption) ?? "";
		const cliDescription = normalizeOptionalString(entry.cliDescription) ?? "";
		const onboardingScopes = normalizeTrimmedStringList(entry.onboardingScopes).filter((scope) => scope === "text-inference" || scope === "image-generation" || scope === "music-generation");
		normalized.push({
			provider,
			method,
			choiceId,
			...choiceLabel ? { choiceLabel } : {},
			...choiceHint ? { choiceHint } : {},
			...assistantPriority !== void 0 ? { assistantPriority } : {},
			...assistantVisibility ? { assistantVisibility } : {},
			...deprecatedChoiceIds.length > 0 ? { deprecatedChoiceIds } : {},
			...groupId ? { groupId } : {},
			...groupLabel ? { groupLabel } : {},
			...groupHint ? { groupHint } : {},
			...onboardingFeatured ? { onboardingFeatured: true } : {},
			...optionKey ? { optionKey } : {},
			...cliFlag ? { cliFlag } : {},
			...cliOption ? { cliOption } : {},
			...cliDescription ? { cliDescription } : {},
			...onboardingScopes.length > 0 ? { onboardingScopes } : {}
		});
	}
	return normalized.length > 0 ? normalized : void 0;
}
function normalizeChannelConfigs(value) {
	if (!isRecord(value)) return;
	const normalized = Object.create(null);
	for (const [key, rawEntry] of Object.entries(value)) {
		const channelId = normalizeOptionalString(key) ?? "";
		if (!channelId || isBlockedObjectKey(channelId) || !isRecord(rawEntry)) continue;
		const schema = isRecord(rawEntry.schema) ? rawEntry.schema : null;
		if (!schema) continue;
		const uiHints = isRecord(rawEntry.uiHints) ? rawEntry.uiHints : void 0;
		const runtime = isRecord(rawEntry.runtime) && typeof rawEntry.runtime.safeParse === "function" ? rawEntry.runtime : void 0;
		const label = normalizeOptionalString(rawEntry.label) ?? "";
		const description = normalizeOptionalString(rawEntry.description) ?? "";
		const preferOver = normalizeTrimmedStringList(rawEntry.preferOver);
		const commandDefaults = normalizeManifestChannelCommandDefaults(rawEntry.commands);
		normalized[channelId] = {
			schema,
			...uiHints ? { uiHints } : {},
			...runtime ? { runtime } : {},
			...label ? { label } : {},
			...description ? { description } : {},
			...preferOver.length > 0 ? { preferOver } : {},
			...commandDefaults ? { commands: commandDefaults } : {}
		};
	}
	return Object.keys(normalized).length > 0 ? normalized : void 0;
}
function normalizeManifestChannelCommandDefaults(value) {
	if (!isRecord(value)) return;
	const nativeCommandsAutoEnabled = typeof value.nativeCommandsAutoEnabled === "boolean" ? value.nativeCommandsAutoEnabled : void 0;
	const nativeSkillsAutoEnabled = typeof value.nativeSkillsAutoEnabled === "boolean" ? value.nativeSkillsAutoEnabled : void 0;
	return nativeCommandsAutoEnabled !== void 0 || nativeSkillsAutoEnabled !== void 0 ? {
		...nativeCommandsAutoEnabled !== void 0 ? { nativeCommandsAutoEnabled } : {},
		...nativeSkillsAutoEnabled !== void 0 ? { nativeSkillsAutoEnabled } : {}
	} : void 0;
}
function resolvePluginManifestPath(rootDir) {
	for (const filename of PLUGIN_MANIFEST_FILENAMES) {
		const candidate = path.join(rootDir, filename);
		if (fs.existsSync(candidate)) return candidate;
	}
	return path.join(rootDir, PLUGIN_MANIFEST_FILENAME);
}
function buildPluginManifestLoadCacheKey(params) {
	return createPluginCacheKey([
		[
			path.resolve(params.manifestPath),
			params.rejectHardlinks,
			params.rootRealPath ?? "",
			params.stats.dev,
			params.stats.ino
		],
		params.stats.size,
		params.stats.mtimeMs,
		params.stats.ctimeMs
	]);
}
function getCachedPluginManifestLoadResult(key, stats) {
	const entry = pluginManifestLoadCache.get(key);
	if (!entry || entry.size !== stats.size || entry.mtimeMs !== stats.mtimeMs || entry.ctimeMs !== stats.ctimeMs) return;
	return entry.result;
}
function setCachedPluginManifestLoadResult(key, stats, result) {
	pluginManifestLoadCache.set(key, {
		result,
		size: stats.size,
		mtimeMs: stats.mtimeMs,
		ctimeMs: stats.ctimeMs
	});
}
function parsePluginKind(raw) {
	if (typeof raw === "string") return raw;
	if (Array.isArray(raw) && raw.length > 0 && raw.every((k) => typeof k === "string")) return raw.length === 1 ? raw[0] : raw;
}
function loadPluginManifest(rootDir, rejectHardlinks = true, rootRealPath) {
	const manifestPath = resolvePluginManifestPath(rootDir);
	const opened = openRootFileSync({
		absolutePath: manifestPath,
		rootPath: rootDir,
		...rootRealPath !== void 0 ? { rootRealPath } : {},
		boundaryLabel: "plugin root",
		maxBytes: MAX_PLUGIN_MANIFEST_BYTES,
		rejectHardlinks
	});
	if (!opened.ok) return matchRootFileOpenFailure(opened, {
		path: () => ({
			ok: false,
			error: `plugin manifest not found: ${manifestPath}`,
			manifestPath
		}),
		fallback: (failure) => ({
			ok: false,
			error: `unsafe plugin manifest path: ${manifestPath} (${failure.reason})`,
			manifestPath
		})
	});
	const stats = opened.stat;
	const cacheKey = buildPluginManifestLoadCacheKey({
		manifestPath,
		rejectHardlinks,
		...rootRealPath !== void 0 ? { rootRealPath } : {},
		stats
	});
	const cached = getCachedPluginManifestLoadResult(cacheKey, stats);
	if (cached) {
		fs.closeSync(opened.fd);
		return cached;
	}
	const cacheResult = (result) => {
		setCachedPluginManifestLoadResult(cacheKey, stats, result);
		return result;
	};
	let raw;
	try {
		raw = parseJsonWithJson5Fallback(fs.readFileSync(opened.fd, "utf-8"));
	} catch (err) {
		return cacheResult({
			ok: false,
			error: `failed to parse plugin manifest: ${String(err)}`,
			manifestPath
		});
	} finally {
		fs.closeSync(opened.fd);
	}
	if (!isRecord(raw)) return cacheResult({
		ok: false,
		error: "plugin manifest must be an object",
		manifestPath
	});
	const id = normalizeOptionalString(raw.id) ?? "";
	if (!id) return cacheResult({
		ok: false,
		error: "plugin manifest requires id",
		manifestPath
	});
	const configSchema = isRecord(raw.configSchema) ? raw.configSchema : null;
	if (!configSchema) return cacheResult({
		ok: false,
		error: "plugin manifest requires configSchema",
		manifestPath
	});
	const kind = parsePluginKind(raw.kind);
	const enabledByDefault = raw.enabledByDefault === true;
	const enabledByDefaultOnPlatforms = normalizeManifestDefaultPlatforms(raw.enabledByDefaultOnPlatforms);
	const legacyPluginIds = normalizeTrimmedStringList(raw.legacyPluginIds);
	const autoEnableWhenConfiguredProviders = normalizeTrimmedStringList(raw.autoEnableWhenConfiguredProviders);
	const name = normalizeOptionalString(raw.name);
	const description = normalizeOptionalString(raw.description);
	const version = normalizeOptionalString(raw.version);
	const channels = normalizeTrimmedStringList(raw.channels);
	const providers = normalizeTrimmedStringList(raw.providers);
	const providerCatalogEntry = normalizeOptionalString(raw.providerCatalogEntry);
	const providerDiscoveryEntry = normalizeOptionalString(raw.providerDiscoveryEntry);
	const modelSupport = normalizeManifestModelSupport(raw.modelSupport);
	const modelCatalog = normalizeModelCatalog(raw.modelCatalog, { ownedProviders: new Set(providers) });
	const modelPricing = normalizeManifestModelPricing(raw.modelPricing, { ownedProviders: new Set(providers) });
	const modelIdNormalization = normalizeManifestModelIdNormalization(raw.modelIdNormalization, { ownedProviders: new Set(providers) });
	const providerEndpoints = normalizeManifestProviderEndpoints(raw.providerEndpoints);
	const providerRequest = normalizeManifestProviderRequest(raw.providerRequest, { ownedProviders: new Set(providers) });
	const cliBackends = normalizeTrimmedStringList(raw.cliBackends);
	const syntheticAuthRefs = normalizeTrimmedStringList(raw.syntheticAuthRefs);
	const nonSecretAuthMarkers = normalizeTrimmedStringList(raw.nonSecretAuthMarkers);
	const commandAliases = normalizeManifestCommandAliases(raw.commandAliases);
	const providerAuthEnvVars = normalizeStringListRecord(raw.providerAuthEnvVars);
	const providerAuthAliases = normalizeStringRecord(raw.providerAuthAliases);
	const channelEnvVars = normalizeStringListRecord(raw.channelEnvVars);
	const providerAuthChoices = normalizeProviderAuthChoices(raw.providerAuthChoices);
	const activation = normalizeManifestActivation(raw.activation);
	const setup = normalizeManifestSetup(raw.setup);
	const qaRunners = normalizeManifestQaRunners(raw.qaRunners);
	const skills = normalizeTrimmedStringList(raw.skills);
	const contracts = normalizeManifestContracts(raw.contracts);
	const mediaUnderstandingProviderMetadata = normalizeMediaUnderstandingProviderMetadata(raw.mediaUnderstandingProviderMetadata);
	const imageGenerationProviderMetadata = normalizeCapabilityProviderMetadata(raw.imageGenerationProviderMetadata);
	const videoGenerationProviderMetadata = normalizeCapabilityProviderMetadata(raw.videoGenerationProviderMetadata);
	const musicGenerationProviderMetadata = normalizeCapabilityProviderMetadata(raw.musicGenerationProviderMetadata);
	const toolMetadata = normalizePluginToolMetadata(raw.toolMetadata);
	const configContracts = normalizeManifestConfigContracts(raw.configContracts);
	const channelConfigs = normalizeChannelConfigs(raw.channelConfigs);
	let uiHints;
	if (isRecord(raw.uiHints)) uiHints = raw.uiHints;
	return cacheResult({
		ok: true,
		manifest: {
			id,
			configSchema,
			...enabledByDefault ? { enabledByDefault } : {},
			...enabledByDefaultOnPlatforms.length > 0 ? { enabledByDefaultOnPlatforms } : {},
			...legacyPluginIds.length > 0 ? { legacyPluginIds } : {},
			...autoEnableWhenConfiguredProviders.length > 0 ? { autoEnableWhenConfiguredProviders } : {},
			kind,
			channels,
			providers,
			providerCatalogEntry,
			providerDiscoveryEntry,
			modelSupport,
			modelCatalog,
			modelPricing,
			modelIdNormalization,
			providerEndpoints,
			providerRequest,
			cliBackends,
			syntheticAuthRefs,
			nonSecretAuthMarkers,
			commandAliases,
			providerAuthEnvVars,
			providerAuthAliases,
			channelEnvVars,
			providerAuthChoices,
			activation,
			setup,
			qaRunners,
			skills,
			name,
			description,
			version,
			uiHints,
			contracts,
			mediaUnderstandingProviderMetadata,
			imageGenerationProviderMetadata,
			videoGenerationProviderMetadata,
			musicGenerationProviderMetadata,
			toolMetadata,
			configContracts,
			channelConfigs
		},
		manifestPath
	});
}
const DEFAULT_PLUGIN_ENTRY_CANDIDATES = [
	"index.ts",
	"index.js",
	"index.mjs",
	"index.cjs"
];
function getPackageManifestMetadata(manifest) {
	if (!manifest) return;
	return manifest[MANIFEST_KEY];
}
function resolvePackageExtensionEntries(manifest) {
	const rawOpenClaw = manifest?.[MANIFEST_KEY];
	if (rawOpenClaw === void 0 || rawOpenClaw === null) return {
		status: "missing",
		entries: []
	};
	if (!isRecord(rawOpenClaw)) return {
		status: "invalid",
		entries: [],
		error: "package.json openclaw must be an object"
	};
	const raw = rawOpenClaw.extensions;
	if (raw === void 0 || raw === null) return {
		status: "missing",
		entries: []
	};
	if (!Array.isArray(raw)) return {
		status: "invalid",
		entries: [],
		error: "package.json openclaw.extensions must be an array"
	};
	const entries = [];
	for (const [index, entry] of raw.entries()) {
		const normalized = normalizeOptionalString(entry);
		if (!normalized) return {
			status: "invalid",
			entries: [],
			error: `package.json openclaw.extensions[${index}] must be a non-empty string`
		};
		entries.push(normalized);
	}
	if (entries.length === 0) return {
		status: "empty",
		entries: []
	};
	return {
		status: "ok",
		entries
	};
}
//#endregion
export { normalizeManifestActivation as a, loadPluginManifest as i, PLUGIN_MANIFEST_FILENAME as n, resolvePackageExtensionEntries as o, getPackageManifestMetadata as r, DEFAULT_PLUGIN_ENTRY_CANDIDATES as t };
