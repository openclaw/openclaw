import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { c as isRecord } from "./utils-sBTEdeml.js";
import { t as isBlockedObjectKey } from "./prototype-keys-gIgii6VQ.js";
import { l as normalizeTrimmedStringList } from "./string-normalization-DiPHgdft.js";
import { t as parseClawHubPluginSpec } from "./clawhub-spec-J_MJr4Sl.js";
import { s as parseRegistryNpmSpec } from "./npm-registry-spec-BwaWslDm.js";
import { r as isModelThinkingFormat, t as MODEL_APIS } from "./types.models-lqH0KLkn.js";
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
		"strictMessageKeys",
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
	if (isModelThinkingFormat(thinkingFormat)) compat.thinkingFormat = thinkingFormat;
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
	const scopes = normalizeTrimmedStringList(value).filter((scope) => scope === "text-inference" || scope === "image-generation" || scope === "music-generation");
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
export { normalizeModelCatalog as a, loadOpenClawProviderIndex as i, planManifestModelCatalogRows as n, buildModelCatalogMergeKey as o, planManifestModelCatalogSuppressions as r, normalizeModelCatalogProviderId as s, planProviderIndexModelCatalogRows as t };
