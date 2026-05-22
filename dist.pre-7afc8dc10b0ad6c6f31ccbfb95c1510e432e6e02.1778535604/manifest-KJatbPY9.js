import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { i as openRootFileSync, n as matchRootFileOpenFailure } from "./root-file-Bp-CoMOV.js";
import { c as isRecord } from "./utils-927g1oFZ.js";
import { t as isBlockedObjectKey } from "./prototype-keys-Cxs5UffD.js";
import { l as normalizeTrimmedStringList } from "./string-normalization-DgUPESoD.js";
import "./boundary-file-read-Csu48sMY.js";
import { n as MANIFEST_KEY } from "./legacy-names-ChddIwxo.js";
import { t as MODEL_APIS } from "./types.models-qWDdXicG.js";
import { t as parseClawHubPluginSpec } from "./clawhub-spec-CBtGZ6ex.js";
import { o as parseRegistryNpmSpec } from "./npm-registry-spec-COugVM2e.js";
import { t as parseJsonWithJson5Fallback } from "./parse-json-compat-BKl22lWW.js";
import { t as normalizeManifestCommandAliases } from "./manifest-command-aliases-At6Dhdtw.js";
import { r as createPluginCacheKey, t as PluginLruCache } from "./plugin-cache-primitives-ip_BGHgo.js";
import fs from "node:fs";
import path from "node:path";
//#region src/model-catalog/refs.ts
function normalizeModelCatalogProviderId(provider) {
	return normalizeLowercaseStringOrEmpty(provider);
}
function buildModelCatalogRef(provider, modelId) {
	return `${normalizeModelCatalogProviderId(provider)}/${modelId}`;
}
function buildModelCatalogMergeKey(provider, modelId) {
	return `${normalizeModelCatalogProviderId(provider)}::${normalizeLowercaseStringOrEmpty(modelId)}`;
}
//#endregion
//#region src/model-catalog/normalize.ts
const MODEL_CATALOG_INPUTS = new Set([
	"text",
	"image",
	"document"
]);
const MODEL_CATALOG_DISCOVERY_MODES = new Set([
	"static",
	"refreshable",
	"runtime"
]);
const MODEL_CATALOG_STATUSES = new Set([
	"available",
	"preview",
	"deprecated",
	"disabled"
]);
const MODEL_CATALOG_APIS = new Set(MODEL_APIS);
const DEFAULT_MODEL_INPUT = ["text"];
const DEFAULT_MODEL_STATUS = "available";
function normalizeSafeRecordKey(value) {
	const key = normalizeOptionalString(value) ?? "";
	return key && !isBlockedObjectKey(key) ? key : "";
}
function normalizeOwnedProviderSet(providers) {
	const normalized = /* @__PURE__ */ new Set();
	for (const provider of providers) {
		const providerId = normalizeModelCatalogProviderId(provider);
		if (providerId) normalized.add(providerId);
	}
	return normalized;
}
function normalizeStringMap(value) {
	if (!isRecord(value)) return;
	const normalized = {};
	for (const [rawKey, rawValue] of Object.entries(value)) {
		const key = normalizeSafeRecordKey(rawKey);
		const mapValue = normalizeOptionalString(rawValue) ?? "";
		if (key && mapValue) normalized[key] = mapValue;
	}
	return Object.keys(normalized).length > 0 ? normalized : void 0;
}
function mergeStringMaps(base, override) {
	if (!base && !override) return;
	return {
		...base,
		...override
	};
}
function normalizeModelCatalogApi(value) {
	const api = normalizeOptionalString(value) ?? "";
	return MODEL_CATALOG_APIS.has(api) ? api : void 0;
}
function normalizeModelCatalogInputs(value) {
	const inputs = normalizeTrimmedStringList(value).filter((input) => MODEL_CATALOG_INPUTS.has(input));
	return inputs.length > 0 ? inputs : void 0;
}
function normalizeNonNegativeNumber(value) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : void 0;
}
function normalizePositiveNumber(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : void 0;
}
function normalizePositiveInteger(value) {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : void 0;
}
function normalizeModelCatalogTieredCost(value) {
	if (!Array.isArray(value)) return;
	const normalized = [];
	for (const entry of value) {
		if (!isRecord(entry) || !Array.isArray(entry.range)) continue;
		const input = normalizeNonNegativeNumber(entry.input);
		const output = normalizeNonNegativeNumber(entry.output);
		const cacheRead = normalizeNonNegativeNumber(entry.cacheRead);
		const cacheWrite = normalizeNonNegativeNumber(entry.cacheWrite);
		if (input === void 0 || output === void 0 || cacheRead === void 0 || cacheWrite === void 0 || entry.range.length < 1 || entry.range.length > 2) continue;
		const rangeValues = entry.range.map((rangeValue) => normalizeNonNegativeNumber(rangeValue));
		if (rangeValues.some((rangeValue) => rangeValue === void 0)) continue;
		normalized.push({
			input,
			output,
			cacheRead,
			cacheWrite,
			range: rangeValues.length === 1 ? [rangeValues[0]] : [rangeValues[0], rangeValues[1]]
		});
	}
	return normalized.length > 0 ? normalized : void 0;
}
function normalizeModelCatalogCost(value) {
	if (!isRecord(value)) return;
	const input = normalizeNonNegativeNumber(value.input);
	const output = normalizeNonNegativeNumber(value.output);
	const cacheRead = normalizeNonNegativeNumber(value.cacheRead);
	const cacheWrite = normalizeNonNegativeNumber(value.cacheWrite);
	const tieredPricing = normalizeModelCatalogTieredCost(value.tieredPricing);
	const cost = {
		...input !== void 0 ? { input } : {},
		...output !== void 0 ? { output } : {},
		...cacheRead !== void 0 ? { cacheRead } : {},
		...cacheWrite !== void 0 ? { cacheWrite } : {},
		...tieredPricing ? { tieredPricing } : {}
	};
	return Object.keys(cost).length > 0 ? cost : void 0;
}
function normalizeModelCatalogCompat(value) {
	if (!isRecord(value)) return;
	const compat = {};
	for (const field of [
		"supportsStore",
		"supportsPromptCacheKey",
		"supportsDeveloperRole",
		"supportsReasoningEffort",
		"supportsUsageInStreaming",
		"supportsTools",
		"supportsStrictMode",
		"requiresStringContent",
		"requiresToolResultName",
		"requiresAssistantAfterToolResult",
		"requiresThinkingAsText",
		"nativeWebSearchTool",
		"requiresMistralToolIds",
		"requiresOpenAiAnthropicToolPayload"
	]) if (typeof value[field] === "boolean") compat[field] = value[field];
	for (const field of ["toolSchemaProfile", "toolCallArgumentsEncoding"]) {
		const normalized = normalizeOptionalString(value[field]) ?? "";
		if (normalized) compat[field] = normalized;
	}
	for (const field of [
		"visibleReasoningDetailTypes",
		"supportedReasoningEfforts",
		"unsupportedToolSchemaKeywords"
	]) {
		const normalized = normalizeTrimmedStringList(value[field]);
		if (normalized.length > 0) compat[field] = normalized;
	}
	if (isRecord(value.reasoningEffortMap)) {
		const reasoningEffortMap = Object.fromEntries(Object.entries(value.reasoningEffortMap).map(([key, mapped]) => [key.trim(), typeof mapped === "string" ? mapped.trim() : ""]).filter(([key, mapped]) => key.length > 0 && mapped.length > 0));
		if (Object.keys(reasoningEffortMap).length > 0) compat.reasoningEffortMap = reasoningEffortMap;
	}
	const maxTokensField = normalizeOptionalString(value.maxTokensField) ?? "";
	if (maxTokensField === "max_completion_tokens" || maxTokensField === "max_tokens") compat.maxTokensField = maxTokensField;
	const thinkingFormat = normalizeOptionalString(value.thinkingFormat) ?? "";
	if (thinkingFormat === "openai" || thinkingFormat === "openrouter" || thinkingFormat === "deepseek" || thinkingFormat === "qwen" || thinkingFormat === "qwen-chat-template" || thinkingFormat === "zai") compat.thinkingFormat = thinkingFormat;
	return Object.keys(compat).length > 0 ? compat : void 0;
}
function normalizeModelCatalogStatus(value) {
	const status = normalizeOptionalString(value) ?? "";
	return MODEL_CATALOG_STATUSES.has(status) ? status : void 0;
}
function normalizeModelCatalogModel(value) {
	if (!isRecord(value)) return;
	const id = normalizeOptionalString(value.id) ?? "";
	if (!id) return;
	const name = normalizeOptionalString(value.name) ?? "";
	const api = normalizeModelCatalogApi(value.api);
	const baseUrl = normalizeOptionalString(value.baseUrl) ?? "";
	const headers = normalizeStringMap(value.headers);
	const input = normalizeModelCatalogInputs(value.input);
	const reasoning = typeof value.reasoning === "boolean" ? value.reasoning : void 0;
	const contextWindow = normalizePositiveNumber(value.contextWindow);
	const contextTokens = normalizePositiveInteger(value.contextTokens);
	const maxTokens = normalizePositiveNumber(value.maxTokens);
	const cost = normalizeModelCatalogCost(value.cost);
	const compat = normalizeModelCatalogCompat(value.compat);
	const status = normalizeModelCatalogStatus(value.status);
	const statusReason = normalizeOptionalString(value.statusReason) ?? "";
	const replaces = normalizeTrimmedStringList(value.replaces);
	const replacedBy = normalizeOptionalString(value.replacedBy) ?? "";
	const tags = normalizeTrimmedStringList(value.tags);
	return {
		id,
		...name ? { name } : {},
		...api ? { api } : {},
		...baseUrl ? { baseUrl } : {},
		...headers ? { headers } : {},
		...input ? { input } : {},
		...reasoning !== void 0 ? { reasoning } : {},
		...contextWindow !== void 0 ? { contextWindow } : {},
		...contextTokens !== void 0 ? { contextTokens } : {},
		...maxTokens !== void 0 ? { maxTokens } : {},
		...cost ? { cost } : {},
		...compat ? { compat } : {},
		...status ? { status } : {},
		...statusReason ? { statusReason } : {},
		...replaces.length > 0 ? { replaces } : {},
		...replacedBy ? { replacedBy } : {},
		...tags.length > 0 ? { tags } : {}
	};
}
function normalizeModelCatalogProvider(value) {
	if (!isRecord(value)) return;
	const models = Array.isArray(value.models) ? value.models.map((entry) => normalizeModelCatalogModel(entry)).filter((entry) => Boolean(entry)) : [];
	if (models.length === 0) return;
	const baseUrl = normalizeOptionalString(value.baseUrl) ?? "";
	const api = normalizeModelCatalogApi(value.api);
	const headers = normalizeStringMap(value.headers);
	return {
		...baseUrl ? { baseUrl } : {},
		...api ? { api } : {},
		...headers ? { headers } : {},
		models
	};
}
function normalizeModelCatalogProviders(value, ownedProviders) {
	if (!isRecord(value)) return;
	const providers = {};
	for (const [rawProviderId, rawProvider] of Object.entries(value)) {
		const providerId = normalizeModelCatalogProviderId(rawProviderId);
		if (!providerId || !ownedProviders.has(providerId)) continue;
		const provider = normalizeModelCatalogProvider(rawProvider);
		if (provider) providers[providerId] = provider;
	}
	return Object.keys(providers).length > 0 ? providers : void 0;
}
function normalizeModelCatalogAliases(value, ownedProviders) {
	if (!isRecord(value)) return;
	const aliases = {};
	for (const [rawAlias, rawTarget] of Object.entries(value)) {
		const alias = normalizeModelCatalogProviderId(rawAlias);
		if (!alias || !isRecord(rawTarget)) continue;
		const provider = normalizeModelCatalogProviderId(normalizeOptionalString(rawTarget.provider) ?? "");
		if (!provider || !ownedProviders.has(provider)) continue;
		const api = normalizeModelCatalogApi(rawTarget.api);
		const baseUrl = normalizeOptionalString(rawTarget.baseUrl) ?? "";
		aliases[alias] = {
			provider,
			...api ? { api } : {},
			...baseUrl ? { baseUrl } : {}
		};
	}
	return Object.keys(aliases).length > 0 ? aliases : void 0;
}
function normalizeModelCatalogSuppressions(value) {
	if (!Array.isArray(value)) return;
	const suppressions = [];
	for (const entry of value) {
		if (!isRecord(entry)) continue;
		const provider = normalizeModelCatalogProviderId(normalizeOptionalString(entry.provider) ?? "");
		const model = normalizeOptionalString(entry.model) ?? "";
		if (!provider || !model) continue;
		const reason = normalizeOptionalString(entry.reason) ?? "";
		const rawWhen = isRecord(entry.when) ? entry.when : void 0;
		const baseUrlHosts = normalizeTrimmedStringList(rawWhen?.baseUrlHosts).map((host) => host.toLowerCase());
		const providerConfigApiIn = normalizeTrimmedStringList(rawWhen?.providerConfigApiIn).map((api) => api.toLowerCase());
		const when = baseUrlHosts.length > 0 || providerConfigApiIn.length > 0 ? {
			...baseUrlHosts.length > 0 ? { baseUrlHosts } : {},
			...providerConfigApiIn.length > 0 ? { providerConfigApiIn } : {}
		} : void 0;
		suppressions.push({
			provider,
			model,
			...reason ? { reason } : {},
			...when ? { when } : {}
		});
	}
	return suppressions.length > 0 ? suppressions : void 0;
}
function normalizeModelCatalogDiscovery(value, ownedProviders) {
	if (!isRecord(value)) return;
	const discovery = {};
	for (const [rawProviderId, rawMode] of Object.entries(value)) {
		const providerId = normalizeModelCatalogProviderId(rawProviderId);
		const mode = normalizeOptionalString(rawMode) ?? "";
		if (providerId && ownedProviders.has(providerId) && MODEL_CATALOG_DISCOVERY_MODES.has(mode)) discovery[providerId] = mode;
	}
	return Object.keys(discovery).length > 0 ? discovery : void 0;
}
function normalizeModelCatalog(value, params) {
	if (!isRecord(value)) return;
	const ownedProviders = normalizeOwnedProviderSet(params.ownedProviders);
	const providers = normalizeModelCatalogProviders(value.providers, ownedProviders);
	const aliases = normalizeModelCatalogAliases(value.aliases, ownedProviders);
	const suppressions = normalizeModelCatalogSuppressions(value.suppressions);
	const discovery = normalizeModelCatalogDiscovery(value.discovery, ownedProviders);
	const catalog = {
		...providers ? { providers } : {},
		...aliases ? { aliases } : {},
		...suppressions ? { suppressions } : {},
		...discovery ? { discovery } : {}
	};
	return Object.keys(catalog).length > 0 ? catalog : void 0;
}
function normalizeStringList(value) {
	const normalized = normalizeTrimmedStringList(value);
	return normalized.length > 0 ? normalized : void 0;
}
function normalizeModelCatalogProviderRows(params) {
	const provider = normalizeModelCatalogProviderId(params.provider);
	if (!provider || !Array.isArray(params.providerCatalog.models)) return [];
	const providerApi = normalizeModelCatalogApi(params.providerCatalog.api);
	const providerBaseUrl = normalizeOptionalString(params.providerCatalog.baseUrl) ?? "";
	const providerHeaders = normalizeStringMap(params.providerCatalog.headers);
	const rows = [];
	for (const model of params.providerCatalog.models) {
		const id = normalizeOptionalString(model.id) ?? "";
		if (!id) continue;
		const api = normalizeModelCatalogApi(model.api) ?? providerApi;
		const baseUrl = normalizeOptionalString(model.baseUrl) ?? providerBaseUrl;
		const headers = mergeStringMaps(providerHeaders, normalizeStringMap(model.headers));
		const contextWindow = normalizePositiveNumber(model.contextWindow);
		const contextTokens = normalizePositiveInteger(model.contextTokens);
		const maxTokens = normalizePositiveNumber(model.maxTokens);
		const cost = normalizeModelCatalogCost(model.cost);
		const compat = normalizeModelCatalogCompat(model.compat);
		const statusReason = normalizeOptionalString(model.statusReason) ?? "";
		const replacedBy = normalizeOptionalString(model.replacedBy) ?? "";
		const replaces = normalizeStringList(model.replaces);
		const tags = normalizeStringList(model.tags);
		rows.push({
			provider,
			id,
			ref: buildModelCatalogRef(provider, id),
			mergeKey: buildModelCatalogMergeKey(provider, id),
			name: normalizeOptionalString(model.name) || id,
			source: params.source,
			input: normalizeModelCatalogInputs(model.input) ?? [...DEFAULT_MODEL_INPUT],
			reasoning: typeof model.reasoning === "boolean" ? model.reasoning : false,
			status: normalizeModelCatalogStatus(model.status) ?? DEFAULT_MODEL_STATUS,
			...api ? { api } : {},
			...baseUrl ? { baseUrl } : {},
			...headers ? { headers } : {},
			...contextWindow !== void 0 ? { contextWindow } : {},
			...contextTokens !== void 0 ? { contextTokens } : {},
			...maxTokens !== void 0 ? { maxTokens } : {},
			...cost ? { cost } : {},
			...compat ? { compat } : {},
			...statusReason ? { statusReason } : {},
			...replaces ? { replaces } : {},
			...replacedBy ? { replacedBy } : {},
			...tags ? { tags } : {}
		});
	}
	return rows.toSorted((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
}
//#endregion
//#region src/model-catalog/provider-index/normalize.ts
const OPENCLAW_PROVIDER_INDEX_VERSION = 1;
function normalizeSafeKey(value) {
	const key = normalizeOptionalString(value) ?? "";
	return key && !isBlockedObjectKey(key) ? key : "";
}
function normalizeInstall(value) {
	if (!isRecord(value)) return;
	const clawhubSpec = normalizeOptionalString(value.clawhubSpec);
	const parsedClawHub = clawhubSpec ? parseClawHubPluginSpec(clawhubSpec) : null;
	const npmSpec = normalizeOptionalString(value.npmSpec);
	const parsedNpm = npmSpec ? parseRegistryNpmSpec(npmSpec) : null;
	if (!parsedClawHub && !parsedNpm) return;
	const defaultChoice = value.defaultChoice === "clawhub" && parsedClawHub ? "clawhub" : value.defaultChoice === "npm" && parsedNpm ? "npm" : void 0;
	const minHostVersion = normalizeOptionalString(value.minHostVersion);
	const expectedIntegrity = normalizeOptionalString(value.expectedIntegrity);
	return {
		...parsedClawHub ? { clawhubSpec } : {},
		...parsedNpm ? { npmSpec: parsedNpm.raw } : {},
		...defaultChoice ? { defaultChoice } : {},
		...minHostVersion ? { minHostVersion } : {},
		...expectedIntegrity ? { expectedIntegrity } : {}
	};
}
function normalizePlugin(value) {
	if (!isRecord(value)) return;
	const id = normalizeSafeKey(value.id);
	if (!id) return;
	const packageName = normalizeOptionalString(value.package) ?? "";
	const source = normalizeOptionalString(value.source) ?? "";
	const install = normalizeInstall(value.install);
	return {
		id,
		...packageName ? { package: packageName } : {},
		...source ? { source } : {},
		...install ? { install } : {}
	};
}
function normalizeCategories(value) {
	return [...new Set(normalizeTrimmedStringList(value))];
}
function normalizePreviewCatalog(params) {
	const provider = normalizeModelCatalog({ providers: { [params.providerId]: params.value } }, { ownedProviders: new Set([params.providerId]) })?.providers?.[params.providerId];
	if (!provider) return;
	for (const model of provider.models) model.status ??= "preview";
	return provider;
}
function normalizeOnboardingScopes(value) {
	const scopes = normalizeTrimmedStringList(value).filter((scope) => scope === "text-inference" || scope === "image-generation");
	return scopes.length > 0 ? [...new Set(scopes)] : void 0;
}
function normalizeAssistantVisibility(value) {
	return value === "visible" || value === "manual-only" ? value : void 0;
}
function normalizeFiniteNumber(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function normalizeAuthChoice(params) {
	if (!isRecord(params.value)) return;
	const method = normalizeSafeKey(params.value.method);
	const choiceId = normalizeSafeKey(params.value.choiceId);
	const choiceLabel = normalizeOptionalString(params.value.choiceLabel) ?? "";
	if (!method || !choiceId || !choiceLabel) return;
	const choiceHint = normalizeOptionalString(params.value.choiceHint);
	const groupId = normalizeSafeKey(params.value.groupId) || params.providerId;
	const groupLabel = normalizeOptionalString(params.value.groupLabel) ?? params.providerName;
	const groupHint = normalizeOptionalString(params.value.groupHint);
	const optionKey = normalizeSafeKey(params.value.optionKey);
	const cliFlag = normalizeOptionalString(params.value.cliFlag);
	const cliOption = normalizeOptionalString(params.value.cliOption);
	const cliDescription = normalizeOptionalString(params.value.cliDescription);
	const assistantPriority = normalizeFiniteNumber(params.value.assistantPriority);
	const assistantVisibility = normalizeAssistantVisibility(params.value.assistantVisibility);
	const onboardingScopes = normalizeOnboardingScopes(params.value.onboardingScopes);
	return {
		method,
		choiceId,
		choiceLabel,
		...choiceHint ? { choiceHint } : {},
		...assistantPriority !== void 0 ? { assistantPriority } : {},
		...assistantVisibility ? { assistantVisibility } : {},
		...groupId ? { groupId } : {},
		...groupLabel ? { groupLabel } : {},
		...groupHint ? { groupHint } : {},
		...optionKey ? { optionKey } : {},
		...cliFlag ? { cliFlag } : {},
		...cliOption ? { cliOption } : {},
		...cliDescription ? { cliDescription } : {},
		...onboardingScopes ? { onboardingScopes } : {}
	};
}
function normalizeAuthChoices(params) {
	if (!Array.isArray(params.value)) return;
	const choices = params.value.map((value) => normalizeAuthChoice({
		...params,
		value
	})).filter((choice) => Boolean(choice));
	return choices.length > 0 ? choices : void 0;
}
function normalizeProvider(rawProviderId, value) {
	if (!isRecord(value)) return;
	const providerId = normalizeModelCatalogProviderId(rawProviderId);
	if (!providerId) return;
	const id = normalizeModelCatalogProviderId(normalizeOptionalString(value.id) ?? "");
	if (id && id !== providerId) return;
	const name = normalizeOptionalString(value.name) ?? "";
	const plugin = normalizePlugin(value.plugin);
	if (!name || !plugin) return;
	const docs = normalizeOptionalString(value.docs) ?? "";
	const categories = normalizeCategories(value.categories);
	const authChoices = normalizeAuthChoices({
		providerId,
		providerName: name,
		value: value.authChoices
	});
	const previewCatalog = normalizePreviewCatalog({
		providerId,
		value: value.previewCatalog
	});
	return {
		id: providerId,
		name,
		plugin,
		...docs ? { docs } : {},
		...categories.length > 0 ? { categories } : {},
		...authChoices ? { authChoices } : {},
		...previewCatalog ? { previewCatalog } : {}
	};
}
function normalizeOpenClawProviderIndex(value) {
	if (!isRecord(value) || value.version !== OPENCLAW_PROVIDER_INDEX_VERSION) return;
	if (!isRecord(value.providers)) return;
	const providers = {};
	for (const [rawProviderId, rawProvider] of Object.entries(value.providers)) {
		const providerId = normalizeModelCatalogProviderId(rawProviderId);
		if (!providerId || isBlockedObjectKey(providerId)) continue;
		const provider = normalizeProvider(providerId, rawProvider);
		if (provider) providers[providerId] = provider;
	}
	return {
		version: OPENCLAW_PROVIDER_INDEX_VERSION,
		providers: Object.fromEntries(Object.entries(providers).toSorted(([left], [right]) => left.localeCompare(right)))
	};
}
//#endregion
//#region src/model-catalog/provider-index/openclaw-provider-index.ts
const OPENCLAW_PROVIDER_INDEX = {
	version: 1,
	providers: {
		moonshot: {
			id: "moonshot",
			name: "Moonshot AI",
			plugin: { id: "moonshot" },
			docs: "/providers/moonshot",
			categories: ["cloud", "llm"],
			previewCatalog: { models: [{
				id: "kimi-k2.6",
				name: "Kimi K2.6",
				input: ["text", "image"],
				contextWindow: 262144
			}] }
		},
		deepseek: {
			id: "deepseek",
			name: "DeepSeek",
			plugin: { id: "deepseek" },
			docs: "/providers/deepseek",
			categories: ["cloud", "llm"],
			previewCatalog: { models: [{
				id: "deepseek-chat",
				name: "DeepSeek Chat",
				input: ["text"],
				contextWindow: 131072
			}, {
				id: "deepseek-reasoner",
				name: "DeepSeek Reasoner",
				input: ["text"],
				reasoning: true,
				contextWindow: 131072
			}] }
		}
	}
};
//#endregion
//#region src/model-catalog/provider-index/load.ts
function loadOpenClawProviderIndex(source = OPENCLAW_PROVIDER_INDEX) {
	return normalizeOpenClawProviderIndex(source) ?? {
		version: 1,
		providers: {}
	};
}
//#endregion
//#region src/model-catalog/manifest-planner.ts
function planManifestModelCatalogRows(params) {
	const providerFilter = params.providerFilter ? normalizeModelCatalogProviderId(params.providerFilter) : void 0;
	const entries = [];
	for (const plugin of params.registry.plugins) for (const entry of planManifestModelCatalogPluginEntries({
		plugin,
		providerFilter
	})) entries.push(entry);
	const rowCandidates = [];
	const seenRows = /* @__PURE__ */ new Map();
	const conflicts = /* @__PURE__ */ new Map();
	for (const entry of entries) for (const row of entry.rows) {
		const seen = seenRows.get(row.mergeKey);
		if (seen) {
			if (!conflicts.has(row.mergeKey)) conflicts.set(row.mergeKey, {
				mergeKey: row.mergeKey,
				ref: seen.row.ref,
				provider: seen.row.provider,
				modelId: seen.row.id,
				firstPluginId: seen.pluginId,
				secondPluginId: entry.pluginId
			});
			continue;
		}
		seenRows.set(row.mergeKey, {
			pluginId: entry.pluginId,
			row
		});
		rowCandidates.push(row);
	}
	const conflictedMergeKeys = new Set(conflicts.keys());
	const rows = rowCandidates.filter((row) => !conflictedMergeKeys.has(row.mergeKey));
	return {
		entries,
		conflicts: [...conflicts.values()],
		rows: rows.toSorted((left, right) => left.provider.localeCompare(right.provider) || left.id.localeCompare(right.id))
	};
}
function planManifestModelCatalogPluginEntries(params) {
	const providers = params.plugin.modelCatalog?.providers;
	if (!providers) return [];
	const aliasesByTargetProvider = buildModelCatalogProviderAliasTargets(params.plugin);
	return Object.entries(providers).flatMap(([provider, providerCatalog]) => {
		const normalizedProvider = normalizeModelCatalogProviderId(provider);
		if (!normalizedProvider) return [];
		const providerAliases = aliasesByTargetProvider.get(normalizedProvider) ?? [];
		const plannedProviders = params.providerFilter ? providerAliases.includes(params.providerFilter) || normalizedProvider === params.providerFilter ? [params.providerFilter] : [] : [normalizedProvider];
		if (plannedProviders.length === 0) return [];
		return plannedProviders.flatMap((plannedProvider) => {
			const rows = normalizeModelCatalogProviderRows({
				provider: plannedProvider,
				providerCatalog,
				source: "manifest"
			});
			if (rows.length === 0) return [];
			return [{
				pluginId: params.plugin.id,
				provider: plannedProvider,
				discovery: params.plugin.modelCatalog?.discovery?.[normalizedProvider],
				rows: applyModelCatalogAliasOverrides({
					rows,
					alias: params.plugin.modelCatalog?.aliases?.[plannedProvider]
				})
			}];
		});
	});
}
function buildOwnedProviderSet(plugin) {
	return new Set((plugin.providers ?? []).map(normalizeModelCatalogProviderId).filter(Boolean));
}
function buildModelCatalogProviderAliasTargets(plugin) {
	const ownedProviders = buildOwnedProviderSet(plugin);
	const aliasesByTargetProvider = /* @__PURE__ */ new Map();
	for (const [rawAlias, alias] of Object.entries(plugin.modelCatalog?.aliases ?? {})) {
		const aliasProvider = normalizeModelCatalogProviderId(rawAlias);
		const targetProvider = normalizeModelCatalogProviderId(alias.provider);
		if (!aliasProvider || !targetProvider || !ownedProviders.has(targetProvider)) continue;
		const aliases = aliasesByTargetProvider.get(targetProvider) ?? [];
		aliases.push(aliasProvider);
		aliasesByTargetProvider.set(targetProvider, aliases);
	}
	return aliasesByTargetProvider;
}
function buildModelCatalogProviderRefs(plugin) {
	const ownedProviders = buildOwnedProviderSet(plugin);
	const refs = new Set(ownedProviders);
	for (const [rawAlias, alias] of Object.entries(plugin.modelCatalog?.aliases ?? {})) {
		const aliasProvider = normalizeModelCatalogProviderId(rawAlias);
		const targetProvider = normalizeModelCatalogProviderId(alias.provider);
		if (aliasProvider && targetProvider && ownedProviders.has(targetProvider)) refs.add(aliasProvider);
	}
	return refs;
}
function applyModelCatalogAliasOverrides(params) {
	const alias = params.alias;
	if (!alias) return params.rows;
	return params.rows.map((row) => ({
		...row,
		...alias.api ? { api: alias.api } : {},
		...alias.baseUrl ? { baseUrl: alias.baseUrl } : {}
	}));
}
function planManifestModelCatalogSuppressions(params) {
	const providerFilter = params.providerFilter ? normalizeModelCatalogProviderId(params.providerFilter) : void 0;
	const modelFilter = params.modelFilter ? normalizeLowercaseStringOrEmpty(params.modelFilter) : void 0;
	const suppressions = [];
	for (const plugin of params.registry.plugins) {
		const providerRefs = buildModelCatalogProviderRefs(plugin);
		for (const suppression of plugin.modelCatalog?.suppressions ?? []) {
			const provider = normalizeModelCatalogProviderId(suppression.provider);
			const model = normalizeLowercaseStringOrEmpty(suppression.model);
			if (!provider || !model) continue;
			if (providerFilter && provider !== providerFilter) continue;
			if (modelFilter && model !== modelFilter) continue;
			if (!providerRefs.has(provider)) continue;
			suppressions.push({
				pluginId: plugin.id,
				provider,
				model,
				mergeKey: buildModelCatalogMergeKey(provider, model),
				...suppression.reason ? { reason: suppression.reason } : {},
				...suppression.when ? { when: suppression.when } : {}
			});
		}
	}
	return { suppressions: suppressions.toSorted((left, right) => left.provider.localeCompare(right.provider) || left.model.localeCompare(right.model) || left.pluginId.localeCompare(right.pluginId)) };
}
//#endregion
//#region src/model-catalog/provider-index-planner.ts
function withPreviewStatusDefaults(providerCatalog) {
	return {
		...providerCatalog,
		models: providerCatalog.models.map((model) => ({
			...model,
			status: model.status ?? "preview"
		}))
	};
}
function planProviderIndexModelCatalogRows(params) {
	const providerFilter = params.providerFilter ? normalizeModelCatalogProviderId(params.providerFilter) : void 0;
	const entries = [];
	for (const [providerId, provider] of Object.entries(params.index.providers)) {
		const normalizedProvider = normalizeModelCatalogProviderId(providerId);
		if (!normalizedProvider || providerFilter && normalizedProvider !== providerFilter || !provider.previewCatalog) continue;
		const rows = normalizeModelCatalogProviderRows({
			provider: normalizedProvider,
			providerCatalog: withPreviewStatusDefaults(provider.previewCatalog),
			source: "provider-index"
		});
		if (rows.length === 0) continue;
		entries.push({
			provider: normalizedProvider,
			pluginId: provider.plugin.id,
			rows
		});
	}
	return {
		entries,
		rows: entries.flatMap((entry) => entry.rows).toSorted((left, right) => left.provider.localeCompare(right.provider) || left.id.localeCompare(right.id))
	};
}
//#endregion
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
	const metadata = {
		...aliases.length > 0 ? { aliases } : {},
		...authProviders.length > 0 ? { authProviders } : {},
		...authSignals ? { authSignals } : {},
		...configSignals ? { configSignals } : {}
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
	const tools = normalizeTrimmedStringList(value.tools);
	const contracts = {
		...embeddedExtensionFactories.length > 0 ? { embeddedExtensionFactories } : {},
		...agentToolResultMiddleware.length > 0 ? { agentToolResultMiddleware } : {},
		...externalAuthProviders.length > 0 ? { externalAuthProviders } : {},
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
		const optionKey = normalizeOptionalString(entry.optionKey) ?? "";
		const cliFlag = normalizeOptionalString(entry.cliFlag) ?? "";
		const cliOption = normalizeOptionalString(entry.cliOption) ?? "";
		const cliDescription = normalizeOptionalString(entry.cliDescription) ?? "";
		const onboardingScopes = normalizeTrimmedStringList(entry.onboardingScopes).filter((scope) => scope === "text-inference" || scope === "image-generation");
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
	const raw = getPackageManifestMetadata(manifest)?.extensions;
	if (!Array.isArray(raw)) return {
		status: "missing",
		entries: []
	};
	const entries = raw.map((entry) => normalizeOptionalString(entry) ?? "").filter(Boolean);
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
export { resolvePackageExtensionEntries as a, planManifestModelCatalogSuppressions as c, buildModelCatalogMergeKey as d, normalizeModelCatalogProviderId as f, loadPluginManifest as i, loadOpenClawProviderIndex as l, PLUGIN_MANIFEST_FILENAME as n, planProviderIndexModelCatalogRows as o, getPackageManifestMetadata as r, planManifestModelCatalogRows as s, DEFAULT_PLUGIN_ENTRY_CANDIDATES as t, normalizeModelCatalog as u };
