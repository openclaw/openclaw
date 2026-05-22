import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-Bje8XVt9.js";
import { c as isRecord, d as resolveConfigDir, p as resolveUserPath } from "./utils-D5swhEXt.js";
import { t as isBlockedObjectKey } from "./prototype-keys-BWjW0VW8.js";
import { l as normalizeTrimmedStringList } from "./string-normalization-C5SGsaST.js";
import { n as resolveBoundaryPath, r as resolveBoundaryPathSync, s as isPathInside$1 } from "./boundary-path-DbcMiy8Y.js";
import { i as openBoundaryFileSync, n as matchBoundaryFileOpenFailure, r as openBoundaryFile } from "./boundary-file-read-oFRaIDYB.js";
import { n as MANIFEST_KEY } from "./legacy-names-b8PgFyB2.js";
import { i as normalizeModelCatalogProviderId, n as normalizeModelCatalogProviderRows, r as buildModelCatalogMergeKey, t as normalizeModelCatalog } from "./normalize-SvyUV8HY.js";
import { t as parseClawHubPluginSpec } from "./clawhub-spec-CIPRxT8T.js";
import { t as parseJsonWithJson5Fallback } from "./parse-json-compat-CrSoP9Qk.js";
import { t as normalizeManifestCommandAliases } from "./manifest-command-aliases-DrjTD2KD.js";
import { r as createPluginCacheKey, t as PluginLruCache } from "./plugin-cache-primitives-WfwcOrBF.js";
import { n as resolveBundledPluginsDir, r as resolveSourceCheckoutDependencyDiagnostic } from "./bundled-dir-DL2yDGTU.js";
import fs from "node:fs";
import JSON5 from "json5";
import path from "node:path";
//#region src/infra/npm-registry-spec.ts
const EXACT_SEMVER_VERSION_RE = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;
const OPENCLAW_STABLE_CORRECTION_VERSION_RE = /^(?<year>\d{4})\.(?<month>[1-9]\d?)\.(?<day>[1-9]\d?)-(?<correction>[1-9]\d*)$/;
const OPENCLAW_STABLE_VERSION_RE = /^(?<year>\d{4})\.(?<month>[1-9]\d?)\.(?<day>[1-9]\d?)$/;
const OPENCLAW_ALPHA_VERSION_RE = /^(?<year>\d{4})\.(?<month>[1-9]\d?)\.(?<day>[1-9]\d?)-alpha\.(?<alpha>[1-9]\d*)$/;
const OPENCLAW_BETA_VERSION_RE = /^(?<year>\d{4})\.(?<month>[1-9]\d?)\.(?<day>[1-9]\d?)-beta\.(?<beta>[1-9]\d*)$/;
const DIST_TAG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
function parseRegistryNpmSpecInternal(rawSpec) {
	const spec = rawSpec.trim();
	if (!spec) return {
		ok: false,
		error: "missing npm spec"
	};
	if (/\s/.test(spec)) return {
		ok: false,
		error: "unsupported npm spec: whitespace is not allowed"
	};
	if (spec.includes("://")) return {
		ok: false,
		error: "unsupported npm spec: URLs are not allowed"
	};
	if (spec.includes("#")) return {
		ok: false,
		error: "unsupported npm spec: git refs are not allowed"
	};
	if (spec.includes(":")) return {
		ok: false,
		error: "unsupported npm spec: protocol specs are not allowed"
	};
	const at = spec.lastIndexOf("@");
	const hasSelector = at > 0;
	const name = hasSelector ? spec.slice(0, at) : spec;
	const selector = hasSelector ? spec.slice(at + 1) : "";
	if (!(name.startsWith("@") ? /^@[a-z0-9][a-z0-9-._~]*\/[a-z0-9][a-z0-9-._~]*$/.test(name) : /^[a-z0-9][a-z0-9-._~]*$/.test(name))) return {
		ok: false,
		error: "unsupported npm spec: expected <name> or <name>@<version> from the npm registry"
	};
	if (!hasSelector) return {
		ok: true,
		parsed: {
			name,
			raw: spec,
			selectorKind: "none",
			selectorIsPrerelease: false
		}
	};
	if (!selector) return {
		ok: false,
		error: "unsupported npm spec: missing version/tag after @"
	};
	if (/[\\/]/.test(selector)) return {
		ok: false,
		error: "unsupported npm spec: invalid version/tag"
	};
	const exactVersionMatch = EXACT_SEMVER_VERSION_RE.exec(selector);
	if (exactVersionMatch) return {
		ok: true,
		parsed: {
			name,
			raw: spec,
			selector,
			selectorKind: "exact-version",
			selectorIsPrerelease: Boolean(exactVersionMatch[4]) && !isOpenClawStableCorrectionVersion(selector)
		}
	};
	if (!DIST_TAG_RE.test(selector)) return {
		ok: false,
		error: "unsupported npm spec: use an exact version or dist-tag (ranges are not allowed)"
	};
	return {
		ok: true,
		parsed: {
			name,
			raw: spec,
			selector,
			selectorKind: "tag",
			selectorIsPrerelease: false
		}
	};
}
function parseRegistryNpmSpec(rawSpec) {
	const parsed = parseRegistryNpmSpecInternal(rawSpec);
	return parsed.ok ? parsed.parsed : null;
}
function validateRegistryNpmSpec(rawSpec) {
	const parsed = parseRegistryNpmSpecInternal(rawSpec);
	return parsed.ok ? null : parsed.error;
}
function isExactSemverVersion(value) {
	return EXACT_SEMVER_VERSION_RE.test(value.trim());
}
function parseOpenClawReleaseVersion(value) {
	const trimmed = value.trim();
	const candidate = [
		{
			match: OPENCLAW_STABLE_VERSION_RE.exec(trimmed),
			channel: "stable"
		},
		{
			match: OPENCLAW_STABLE_CORRECTION_VERSION_RE.exec(trimmed),
			channel: "stable"
		},
		{
			match: OPENCLAW_ALPHA_VERSION_RE.exec(trimmed),
			channel: "alpha"
		},
		{
			match: OPENCLAW_BETA_VERSION_RE.exec(trimmed),
			channel: "beta"
		}
	].find((entry) => entry.match?.groups);
	if (!candidate?.match?.groups) return null;
	const year = Number.parseInt(candidate.match.groups.year ?? "", 10);
	const month = Number.parseInt(candidate.match.groups.month ?? "", 10);
	const day = Number.parseInt(candidate.match.groups.day ?? "", 10);
	if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
	const date = new Date(Date.UTC(year, month - 1, day));
	if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
	const correctionNumber = candidate.channel === "stable" && candidate.match.groups.correction ? Number.parseInt(candidate.match.groups.correction, 10) : void 0;
	const alphaNumber = candidate.channel === "alpha" ? Number.parseInt(candidate.match.groups.alpha ?? "", 10) : void 0;
	const betaNumber = candidate.channel === "beta" ? Number.parseInt(candidate.match.groups.beta ?? "", 10) : void 0;
	return {
		channel: candidate.channel,
		dateTime: date.getTime(),
		correctionNumber,
		alphaNumber,
		betaNumber
	};
}
function isOpenClawStableCorrectionVersion(value) {
	const parsed = parseOpenClawReleaseVersion(value);
	return parsed?.channel === "stable" && parsed.correctionNumber !== void 0;
}
function compareOpenClawReleaseVersions(left, right) {
	const parsedLeft = parseOpenClawReleaseVersion(left);
	const parsedRight = parseOpenClawReleaseVersion(right);
	if (!parsedLeft || !parsedRight) return null;
	if (parsedLeft.dateTime !== parsedRight.dateTime) return parsedLeft.dateTime < parsedRight.dateTime ? -1 : 1;
	if (parsedLeft.channel !== parsedRight.channel) {
		const rank = {
			alpha: 0,
			beta: 1,
			stable: 2
		};
		return rank[parsedLeft.channel] < rank[parsedRight.channel] ? -1 : 1;
	}
	if (parsedLeft.channel === "alpha") return Math.sign((parsedLeft.alphaNumber ?? 0) - (parsedRight.alphaNumber ?? 0));
	if (parsedLeft.channel === "beta") return Math.sign((parsedLeft.betaNumber ?? 0) - (parsedRight.betaNumber ?? 0));
	return Math.sign((parsedLeft.correctionNumber ?? 0) - (parsedRight.correctionNumber ?? 0));
}
function isPrereleaseSemverVersion(value) {
	const trimmed = value.trim();
	const match = EXACT_SEMVER_VERSION_RE.exec(trimmed);
	return Boolean(match?.[4]) && !isOpenClawStableCorrectionVersion(trimmed);
}
function isPrereleaseResolutionAllowed(params) {
	if (!params.resolvedVersion || !isPrereleaseSemverVersion(params.resolvedVersion)) return true;
	if (params.spec.selectorKind === "none") return false;
	if (params.spec.selectorKind === "exact-version") return params.spec.selectorIsPrerelease;
	return normalizeLowercaseStringOrEmpty(params.spec.selector) !== "latest";
}
function formatPrereleaseResolutionError(params) {
	const selectorHint = params.spec.selectorKind === "none" || normalizeLowercaseStringOrEmpty(params.spec.selector) === "latest" ? `Use "${params.spec.name}@beta" (or another prerelease tag) or an exact prerelease version to opt in explicitly.` : `Use an explicit prerelease tag or exact prerelease version if you want prerelease installs.`;
	return `Resolved ${params.spec.raw} to prerelease version ${params.resolvedVersion}, but prereleases are only installed when explicitly requested. ${selectorHint}`;
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
	const opened = openBoundaryFileSync({
		absolutePath: manifestPath,
		rootPath: rootDir,
		...rootRealPath !== void 0 ? { rootRealPath } : {},
		boundaryLabel: "plugin root",
		maxBytes: MAX_PLUGIN_MANIFEST_BYTES,
		rejectHardlinks
	});
	if (!opened.ok) return matchBoundaryFileOpenFailure(opened, {
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
//#region src/plugins/bundle-manifest.ts
const CODEX_BUNDLE_MANIFEST_RELATIVE_PATH = ".codex-plugin/plugin.json";
const CLAUDE_BUNDLE_MANIFEST_RELATIVE_PATH = ".claude-plugin/plugin.json";
const CURSOR_BUNDLE_MANIFEST_RELATIVE_PATH = ".cursor-plugin/plugin.json";
function normalizePathList(value) {
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed ? [trimmed] : [];
	}
	if (!Array.isArray(value)) return [];
	return value.map((entry) => normalizeOptionalString(entry)).filter((entry) => Boolean(entry));
}
function normalizeBundlePathList(value) {
	return Array.from(new Set(normalizePathList(value)));
}
function mergeBundlePathLists(...groups) {
	const merged = [];
	const seen = /* @__PURE__ */ new Set();
	for (const group of groups) for (const entry of group) {
		if (seen.has(entry)) continue;
		seen.add(entry);
		merged.push(entry);
	}
	return merged;
}
function hasInlineCapabilityValue(value) {
	if (typeof value === "string") return value.trim().length > 0;
	if (Array.isArray(value)) return value.length > 0;
	if (isRecord(value)) return Object.keys(value).length > 0;
	return value === true;
}
function slugifyPluginId(raw, rootDir) {
	const fallback = path.basename(rootDir);
	return (normalizeLowercaseStringOrEmpty(raw) || normalizeLowercaseStringOrEmpty(fallback)).replace(/[^a-z0-9]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "") || "bundle-plugin";
}
function loadBundleManifestFile(params) {
	const manifestPath = path.join(params.rootDir, params.manifestRelativePath);
	const opened = openBoundaryFileSync({
		absolutePath: manifestPath,
		rootPath: params.rootDir,
		...params.rootRealPath !== void 0 ? { rootRealPath: params.rootRealPath } : {},
		boundaryLabel: "plugin root",
		rejectHardlinks: params.rejectHardlinks
	});
	if (!opened.ok) return matchBoundaryFileOpenFailure(opened, {
		path: () => {
			if (params.allowMissing) return {
				ok: true,
				raw: {},
				manifestPath
			};
			return {
				ok: false,
				error: `plugin manifest not found: ${manifestPath}`,
				manifestPath
			};
		},
		fallback: (failure) => ({
			ok: false,
			error: `unsafe plugin manifest path: ${manifestPath} (${failure.reason})`,
			manifestPath
		})
	});
	try {
		const raw = JSON5.parse(fs.readFileSync(opened.fd, "utf-8"));
		if (!isRecord(raw)) return {
			ok: false,
			error: "plugin manifest must be an object",
			manifestPath
		};
		return {
			ok: true,
			raw,
			manifestPath
		};
	} catch (err) {
		return {
			ok: false,
			error: `failed to parse plugin manifest: ${String(err)}`,
			manifestPath
		};
	} finally {
		fs.closeSync(opened.fd);
	}
}
function resolveCodexSkillDirs(raw, rootDir) {
	const declared = normalizeBundlePathList(raw.skills);
	if (declared.length > 0) return declared;
	return fs.existsSync(path.join(rootDir, "skills")) ? ["skills"] : [];
}
function resolveCodexHookDirs(raw, rootDir) {
	const declared = normalizeBundlePathList(raw.hooks);
	if (declared.length > 0) return declared;
	return fs.existsSync(path.join(rootDir, "hooks")) ? ["hooks"] : [];
}
function resolveCursorSkillsRootDirs(raw, rootDir) {
	const declared = normalizeBundlePathList(raw.skills);
	return mergeBundlePathLists(fs.existsSync(path.join(rootDir, "skills")) ? ["skills"] : [], declared);
}
function resolveCursorCommandRootDirs(raw, rootDir) {
	const declared = normalizeBundlePathList(raw.commands);
	return mergeBundlePathLists(fs.existsSync(path.join(rootDir, ".cursor", "commands")) ? [".cursor/commands"] : [], declared);
}
function resolveCursorSkillDirs(raw, rootDir) {
	return mergeBundlePathLists(resolveCursorSkillsRootDirs(raw, rootDir), resolveCursorCommandRootDirs(raw, rootDir));
}
function resolveCursorAgentDirs(raw, rootDir) {
	const declared = normalizeBundlePathList(raw.subagents ?? raw.agents);
	return mergeBundlePathLists(fs.existsSync(path.join(rootDir, ".cursor", "agents")) ? [".cursor/agents"] : [], declared);
}
function hasCursorHookCapability(raw, rootDir) {
	return hasInlineCapabilityValue(raw.hooks) || fs.existsSync(path.join(rootDir, ".cursor", "hooks.json"));
}
function hasCursorRulesCapability(raw, rootDir) {
	return hasInlineCapabilityValue(raw.rules) || fs.existsSync(path.join(rootDir, ".cursor", "rules"));
}
function hasCursorMcpCapability(raw, rootDir) {
	return hasInlineCapabilityValue(raw.mcpServers) || fs.existsSync(path.join(rootDir, ".mcp.json"));
}
function resolveClaudeComponentPaths(raw, key, rootDir, defaults) {
	const declared = normalizeBundlePathList(raw[key]);
	return mergeBundlePathLists(defaults.filter((candidate) => fs.existsSync(path.join(rootDir, candidate))), declared);
}
function resolveClaudeSkillsRootDirs(raw, rootDir) {
	return resolveClaudeComponentPaths(raw, "skills", rootDir, ["skills"]);
}
function resolveClaudeCommandRootDirs(raw, rootDir) {
	return resolveClaudeComponentPaths(raw, "commands", rootDir, ["commands"]);
}
function resolveClaudeSkillDirs(raw, rootDir) {
	return mergeBundlePathLists(resolveClaudeSkillsRootDirs(raw, rootDir), resolveClaudeCommandRootDirs(raw, rootDir), resolveClaudeAgentDirs(raw, rootDir), resolveClaudeOutputStylePaths(raw, rootDir));
}
function resolveClaudeAgentDirs(raw, rootDir) {
	return resolveClaudeComponentPaths(raw, "agents", rootDir, ["agents"]);
}
function resolveClaudeHookPaths(raw, rootDir) {
	return resolveClaudeComponentPaths(raw, "hooks", rootDir, ["hooks/hooks.json"]);
}
function resolveClaudeMcpPaths(raw, rootDir) {
	return resolveClaudeComponentPaths(raw, "mcpServers", rootDir, [".mcp.json"]);
}
function resolveClaudeLspPaths(raw, rootDir) {
	return resolveClaudeComponentPaths(raw, "lspServers", rootDir, [".lsp.json"]);
}
function resolveClaudeOutputStylePaths(raw, rootDir) {
	return resolveClaudeComponentPaths(raw, "outputStyles", rootDir, ["output-styles"]);
}
function resolveClaudeSettingsFiles(_raw, rootDir) {
	return fs.existsSync(path.join(rootDir, "settings.json")) ? ["settings.json"] : [];
}
function hasClaudeHookCapability(raw, rootDir) {
	return hasInlineCapabilityValue(raw.hooks) || resolveClaudeHookPaths(raw, rootDir).length > 0;
}
function buildCodexCapabilities(raw, rootDir) {
	const capabilities = [];
	if (resolveCodexSkillDirs(raw, rootDir).length > 0) capabilities.push("skills");
	if (resolveCodexHookDirs(raw, rootDir).length > 0) capabilities.push("hooks");
	if (hasInlineCapabilityValue(raw.mcpServers) || fs.existsSync(path.join(rootDir, ".mcp.json"))) capabilities.push("mcpServers");
	if (hasInlineCapabilityValue(raw.apps) || fs.existsSync(path.join(rootDir, ".app.json"))) capabilities.push("apps");
	return capabilities;
}
function buildClaudeCapabilities(raw, rootDir) {
	const capabilities = [];
	if (resolveClaudeSkillDirs(raw, rootDir).length > 0) capabilities.push("skills");
	if (resolveClaudeCommandRootDirs(raw, rootDir).length > 0) capabilities.push("commands");
	if (resolveClaudeAgentDirs(raw, rootDir).length > 0) capabilities.push("agents");
	if (hasClaudeHookCapability(raw, rootDir)) capabilities.push("hooks");
	if (hasInlineCapabilityValue(raw.mcpServers) || resolveClaudeMcpPaths(raw, rootDir).length > 0) capabilities.push("mcpServers");
	if (hasInlineCapabilityValue(raw.lspServers) || resolveClaudeLspPaths(raw, rootDir).length > 0) capabilities.push("lspServers");
	if (hasInlineCapabilityValue(raw.outputStyles) || resolveClaudeOutputStylePaths(raw, rootDir).length > 0) capabilities.push("outputStyles");
	if (resolveClaudeSettingsFiles(raw, rootDir).length > 0) capabilities.push("settings");
	return capabilities;
}
function buildCursorCapabilities(raw, rootDir) {
	const capabilities = [];
	if (resolveCursorSkillDirs(raw, rootDir).length > 0) capabilities.push("skills");
	if (resolveCursorCommandRootDirs(raw, rootDir).length > 0) capabilities.push("commands");
	if (resolveCursorAgentDirs(raw, rootDir).length > 0) capabilities.push("agents");
	if (hasCursorHookCapability(raw, rootDir)) capabilities.push("hooks");
	if (hasCursorRulesCapability(raw, rootDir)) capabilities.push("rules");
	if (hasCursorMcpCapability(raw, rootDir)) capabilities.push("mcpServers");
	return capabilities;
}
function loadBundleManifest(params) {
	const rejectHardlinks = params.rejectHardlinks ?? true;
	const manifestRelativePath = params.bundleFormat === "codex" ? CODEX_BUNDLE_MANIFEST_RELATIVE_PATH : params.bundleFormat === "cursor" ? CURSOR_BUNDLE_MANIFEST_RELATIVE_PATH : CLAUDE_BUNDLE_MANIFEST_RELATIVE_PATH;
	const loaded = loadBundleManifestFile({
		rootDir: params.rootDir,
		...params.rootRealPath !== void 0 ? { rootRealPath: params.rootRealPath } : {},
		manifestRelativePath,
		rejectHardlinks,
		allowMissing: params.bundleFormat === "claude"
	});
	if (!loaded.ok) return loaded;
	const raw = loaded.raw;
	const interfaceRecord = isRecord(raw.interface) ? raw.interface : void 0;
	const name = normalizeOptionalString(raw.name);
	const description = normalizeOptionalString(raw.description) ?? normalizeOptionalString(raw.shortDescription) ?? normalizeOptionalString(interfaceRecord?.shortDescription);
	const version = normalizeOptionalString(raw.version);
	if (params.bundleFormat === "codex") {
		const skills = resolveCodexSkillDirs(raw, params.rootDir);
		const hooks = resolveCodexHookDirs(raw, params.rootDir);
		return {
			ok: true,
			manifest: {
				id: slugifyPluginId(name, params.rootDir),
				name,
				description,
				version,
				skills,
				settingsFiles: [],
				hooks,
				bundleFormat: "codex",
				capabilities: buildCodexCapabilities(raw, params.rootDir)
			},
			manifestPath: loaded.manifestPath
		};
	}
	if (params.bundleFormat === "cursor") return {
		ok: true,
		manifest: {
			id: slugifyPluginId(name, params.rootDir),
			name,
			description,
			version,
			skills: resolveCursorSkillDirs(raw, params.rootDir),
			settingsFiles: [],
			hooks: [],
			bundleFormat: "cursor",
			capabilities: buildCursorCapabilities(raw, params.rootDir)
		},
		manifestPath: loaded.manifestPath
	};
	return {
		ok: true,
		manifest: {
			id: slugifyPluginId(name, params.rootDir),
			name,
			description,
			version,
			skills: resolveClaudeSkillDirs(raw, params.rootDir),
			settingsFiles: resolveClaudeSettingsFiles(raw, params.rootDir),
			hooks: resolveClaudeHookPaths(raw, params.rootDir),
			bundleFormat: "claude",
			capabilities: buildClaudeCapabilities(raw, params.rootDir)
		},
		manifestPath: loaded.manifestPath
	};
}
function detectBundleManifestFormat(rootDir) {
	if (fs.existsSync(path.join(rootDir, ".codex-plugin/plugin.json"))) return "codex";
	if (fs.existsSync(path.join(rootDir, ".cursor-plugin/plugin.json"))) return "cursor";
	if (fs.existsSync(path.join(rootDir, ".claude-plugin/plugin.json"))) return "claude";
	if (fs.existsSync(path.join(rootDir, "openclaw.plugin.json"))) return null;
	if (DEFAULT_PLUGIN_ENTRY_CANDIDATES.some((candidate) => fs.existsSync(path.join(rootDir, candidate)))) return null;
	if ([
		path.join(rootDir, "skills"),
		path.join(rootDir, "commands"),
		path.join(rootDir, "agents"),
		path.join(rootDir, "hooks", "hooks.json"),
		path.join(rootDir, ".mcp.json"),
		path.join(rootDir, ".lsp.json"),
		path.join(rootDir, "settings.json")
	].some((candidate) => fs.existsSync(candidate))) return "claude";
	return null;
}
//#endregion
//#region src/plugins/path-safety.ts
function isPathInside(baseDir, targetPath) {
	return isPathInside$1(baseDir, targetPath);
}
function safeRealpathSync(targetPath, cache) {
	const cached = cache?.get(targetPath);
	if (cached) return cached;
	try {
		const resolved = fs.realpathSync(targetPath);
		cache?.set(targetPath, resolved);
		cache?.set(resolved, resolved);
		return resolved;
	} catch {
		return null;
	}
}
function safeStatSync(targetPath) {
	try {
		return fs.statSync(targetPath);
	} catch {
		return null;
	}
}
function formatPosixMode(mode) {
	return (mode & 511).toString(8).padStart(3, "0");
}
//#endregion
//#region src/plugins/bundled-load-path-aliases.ts
const PACKAGED_BUNDLED_ROOTS = [path.join("dist", "extensions"), path.join("dist-runtime", "extensions")];
function normalizeBundledLookupPath(targetPath) {
	const normalized = path.normalize(targetPath);
	const root = path.parse(normalized).root;
	let trimmed = normalized;
	while (trimmed.length > root.length && (trimmed.endsWith(path.sep) || trimmed.endsWith("/"))) trimmed = trimmed.slice(0, -1);
	return trimmed;
}
function findPackagedBundledRoot(localPath) {
	const normalized = normalizeBundledLookupPath(localPath);
	for (const packagedRoot of PACKAGED_BUNDLED_ROOTS) {
		const marker = `${path.sep}${packagedRoot}`;
		const markerIndex = normalized.lastIndexOf(marker);
		if (markerIndex === -1) continue;
		const markerEnd = markerIndex + marker.length;
		if (normalized.length !== markerEnd && normalized[markerEnd] !== path.sep) continue;
		return {
			packageRoot: normalized.slice(0, markerIndex),
			bundledRoot: normalized.slice(0, markerEnd)
		};
	}
	return null;
}
function buildLegacyBundledPath(localPath) {
	const packaged = findPackagedBundledRoot(localPath);
	if (!packaged) return null;
	const normalized = normalizeBundledLookupPath(localPath);
	const bundledLeaf = normalized === packaged.bundledRoot ? "" : normalized.slice(packaged.bundledRoot.length + path.sep.length);
	return bundledLeaf ? path.join(packaged.packageRoot, "extensions", bundledLeaf) : null;
}
function buildLegacyBundledRootPath(localPath) {
	const packaged = findPackagedBundledRoot(localPath);
	return packaged ? path.join(packaged.packageRoot, "extensions") : null;
}
function buildBundledPluginLoadPathAliases(localPath) {
	const legacyPath = buildLegacyBundledPath(localPath);
	if (!legacyPath) return [];
	return [{
		kind: "current",
		path: localPath
	}, {
		kind: "legacy",
		path: legacyPath
	}];
}
function isSameOrInside(baseDir, targetPath) {
	const base = path.resolve(normalizeBundledLookupPath(baseDir));
	const target = path.resolve(normalizeBundledLookupPath(targetPath));
	return target === base || isPathInside(base, target);
}
function resolvePackagedBundledLoadPathAlias(params) {
	if (!params.bundledRoot) return null;
	const packaged = findPackagedBundledRoot(params.bundledRoot);
	if (!packaged) return null;
	const legacyRoot = path.join(packaged.packageRoot, "extensions");
	if (isSameOrInside(params.bundledRoot, params.loadPath)) return {
		kind: "current",
		path: params.loadPath
	};
	if (isSameOrInside(legacyRoot, params.loadPath)) return {
		kind: "legacy",
		path: params.loadPath
	};
	return null;
}
//#endregion
//#region src/plugins/bundled-source-overlays.ts
function decodeMountInfoPath(value) {
	return value.replace(/\\([0-7]{3})/g, (_match, octal) => String.fromCharCode(Number.parseInt(octal, 8)));
}
function parseLinuxMountInfoMountPoints(mountInfo) {
	const mountPoints = /* @__PURE__ */ new Set();
	for (const line of mountInfo.split(/\r?\n/u)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const mountPoint = trimmed.split(" ")[4];
		if (!mountPoint) continue;
		mountPoints.add(path.resolve(decodeMountInfoPath(mountPoint)));
	}
	return mountPoints;
}
function readLinuxMountPoints() {
	try {
		return parseLinuxMountInfoMountPoints(fs.readFileSync("/proc/self/mountinfo", "utf8"));
	} catch {
		return /* @__PURE__ */ new Set();
	}
}
function isFilesystemMountPoint(targetPath) {
	try {
		const target = fs.statSync(targetPath);
		const parent = fs.statSync(path.dirname(targetPath));
		return target.dev !== parent.dev || target.ino === parent.ino;
	} catch {
		return false;
	}
}
function sourceOverlaysDisabled(env) {
	const raw = normalizeOptionalLowercaseString(env.OPENCLAW_DISABLE_BUNDLED_SOURCE_OVERLAYS);
	return raw === "1" || raw === "true";
}
function isBundledSourceOverlayPath(params) {
	const resolved = path.resolve(params.sourcePath);
	return (params.mountPoints ?? readLinuxMountPoints()).has(resolved) || isFilesystemMountPoint(resolved);
}
function listBundledSourceOverlayDirs(params) {
	if (sourceOverlaysDisabled(params.env ?? process.env) || !params.bundledRoot) return [];
	const legacyRoot = buildLegacyBundledRootPath(params.bundledRoot);
	if (!legacyRoot || !fs.existsSync(legacyRoot)) return [];
	let entries;
	try {
		entries = fs.readdirSync(legacyRoot, { withFileTypes: true });
	} catch {
		return [];
	}
	const mountPoints = params.mountPoints ?? readLinuxMountPoints();
	const legacyRootMounted = isBundledSourceOverlayPath({
		sourcePath: legacyRoot,
		mountPoints
	});
	const overlayDirs = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const sourceDir = path.join(legacyRoot, entry.name);
		const bundledPeer = path.join(params.bundledRoot, entry.name);
		if (!fs.existsSync(bundledPeer)) continue;
		if (!legacyRootMounted && !isBundledSourceOverlayPath({
			sourcePath: sourceDir,
			mountPoints
		})) continue;
		overlayDirs.push(sourceDir);
	}
	return overlayDirs.toSorted((left, right) => left.localeCompare(right));
}
//#endregion
//#region src/plugins/package-entrypoints.ts
function isTypeScriptPackageEntry(entryPath) {
	return [
		".ts",
		".mts",
		".cts"
	].includes(path.extname(entryPath).toLowerCase());
}
function listBuiltRuntimeEntryCandidates(entryPath) {
	if (!isTypeScriptPackageEntry(entryPath)) return [];
	const normalized = entryPath.replace(/\\/g, "/");
	const withoutExtension = normalized.replace(/\.[^.]+$/u, "");
	const normalizedRelative = normalized.replace(/^\.\//u, "");
	const distWithoutExtension = normalizedRelative.startsWith("src/") ? `./dist/${normalizedRelative.slice(4).replace(/\.[^.]+$/u, "")}` : `./dist/${withoutExtension.replace(/^\.\//u, "")}`;
	const withJavaScriptExtensions = (basePath) => [
		`${basePath}.js`,
		`${basePath}.mjs`,
		`${basePath}.cjs`
	];
	const candidates = [...withJavaScriptExtensions(distWithoutExtension), ...withJavaScriptExtensions(withoutExtension)];
	return [...new Set(candidates)].filter((candidate) => candidate !== normalized);
}
//#endregion
//#region src/plugins/package-entry-resolution.ts
function runtimeExtensionsLengthMismatchMessage(params) {
	return `package.json openclaw.runtimeExtensions length (${params.runtimeExtensionsLength}) must match openclaw.extensions length (${params.extensionsLength})`;
}
function readPackageManifestStringList(params) {
	if (!Array.isArray(params.value)) return {
		ok: true,
		entries: []
	};
	const entries = [];
	for (const [index, entry] of params.value.entries()) {
		const normalized = normalizeOptionalString(entry);
		if (!normalized) return {
			ok: false,
			error: `package.json ${params.fieldName}[${index}] must be a non-empty string`
		};
		entries.push(normalized);
	}
	return {
		ok: true,
		entries
	};
}
function resolvePackageRuntimeExtensionEntries(params) {
	const runtimeExtensionsResult = readPackageManifestStringList({
		fieldName: "openclaw.runtimeExtensions",
		value: getPackageManifestMetadata(params.manifest ?? void 0)?.runtimeExtensions
	});
	if (!runtimeExtensionsResult.ok) return runtimeExtensionsResult;
	const runtimeExtensions = runtimeExtensionsResult.entries;
	if (runtimeExtensions.length === 0) return {
		ok: true,
		runtimeExtensions: []
	};
	if (runtimeExtensions.length !== params.extensions.length) return {
		ok: false,
		error: runtimeExtensionsLengthMismatchMessage({
			runtimeExtensionsLength: runtimeExtensions.length,
			extensionsLength: params.extensions.length
		})
	};
	return {
		ok: true,
		runtimeExtensions
	};
}
function missingCompiledRuntimeEntryMessage(params) {
	return `${params.label} requires compiled runtime output for TypeScript entry ${params.entry}: expected ${params.candidates.join(", ")}`;
}
async function validatePackageExtensionEntry(params) {
	const absolutePath = path.resolve(params.packageDir, params.entry);
	try {
		if (!(await resolveBoundaryPath({
			absolutePath,
			rootPath: params.packageDir,
			boundaryLabel: "plugin package directory"
		})).exists) return params.requireExisting ? {
			ok: false,
			error: `${params.label} not found: ${params.entry}`
		} : {
			ok: true,
			exists: false
		};
	} catch {
		return {
			ok: false,
			error: `${params.label} escapes plugin directory: ${params.entry}`
		};
	}
	const opened = await openBoundaryFile({
		absolutePath,
		rootPath: params.packageDir,
		boundaryLabel: "plugin package directory"
	});
	if (!opened.ok) return matchBoundaryFileOpenFailure(opened, {
		path: () => ({
			ok: false,
			error: `${params.label} not found: ${params.entry}`
		}),
		io: () => ({
			ok: false,
			error: `${params.label} unreadable: ${params.entry}`
		}),
		validation: () => ({
			ok: false,
			error: `${params.label} failed plugin directory boundary checks: ${params.entry}`
		}),
		fallback: () => ({
			ok: false,
			error: `${params.label} failed plugin directory boundary checks: ${params.entry}`
		})
	});
	fs.closeSync(opened.fd);
	return {
		ok: true,
		exists: true
	};
}
async function validatePackageExtensionEntriesForInstall(params) {
	const runtimeResolution = resolvePackageRuntimeExtensionEntries({
		manifest: params.manifest,
		extensions: params.extensions
	});
	if (!runtimeResolution.ok) return runtimeResolution;
	for (const [index, entry] of params.extensions.entries()) {
		const sourceEntry = await validatePackageExtensionEntry({
			packageDir: params.packageDir,
			entry,
			label: "extension entry",
			requireExisting: false
		});
		if (!sourceEntry.ok) return sourceEntry;
		const runtimeEntry = runtimeResolution.runtimeExtensions[index];
		if (runtimeEntry) {
			const runtimeResult = await validatePackageExtensionEntry({
				packageDir: params.packageDir,
				entry: runtimeEntry,
				label: "runtime extension entry",
				requireExisting: true
			});
			if (!runtimeResult.ok) return runtimeResult;
			continue;
		}
		let foundBuiltEntry = false;
		const builtEntryCandidates = listBuiltRuntimeEntryCandidates(entry);
		for (const builtEntry of builtEntryCandidates) {
			const builtResult = await validatePackageExtensionEntry({
				packageDir: params.packageDir,
				entry: builtEntry,
				label: "inferred runtime extension entry",
				requireExisting: false
			});
			if (!builtResult.ok) return builtResult;
			if (builtResult.exists) {
				foundBuiltEntry = true;
				break;
			}
		}
		if (foundBuiltEntry) continue;
		if (sourceEntry.exists && isTypeScriptPackageEntry(entry)) return {
			ok: false,
			error: missingCompiledRuntimeEntryMessage({
				label: "package install",
				entry,
				candidates: builtEntryCandidates
			})
		};
		if (sourceEntry.exists) continue;
		if (builtEntryCandidates.length > 0) return {
			ok: false,
			error: missingCompiledRuntimeEntryMessage({
				label: "package install",
				entry,
				candidates: builtEntryCandidates
			})
		};
		return {
			ok: false,
			error: `extension entry not found: ${entry}`
		};
	}
	const packageManifest = getPackageManifestMetadata(params.manifest);
	const setupEntry = normalizeOptionalString(packageManifest?.setupEntry);
	const runtimeSetupEntry = normalizeOptionalString(packageManifest?.runtimeSetupEntry);
	if (runtimeSetupEntry && !setupEntry) return {
		ok: false,
		error: "package.json openclaw.runtimeSetupEntry requires openclaw.setupEntry"
	};
	if (setupEntry) {
		const sourceEntry = await validatePackageExtensionEntry({
			packageDir: params.packageDir,
			entry: setupEntry,
			label: "setup entry",
			requireExisting: false
		});
		if (!sourceEntry.ok) return sourceEntry;
		if (runtimeSetupEntry) {
			const runtimeResult = await validatePackageExtensionEntry({
				packageDir: params.packageDir,
				entry: runtimeSetupEntry,
				label: "runtime setup entry",
				requireExisting: true
			});
			if (!runtimeResult.ok) return runtimeResult;
			return { ok: true };
		}
		let foundBuiltSetupEntry = false;
		const builtSetupCandidates = listBuiltRuntimeEntryCandidates(setupEntry);
		for (const builtEntry of builtSetupCandidates) {
			const builtResult = await validatePackageExtensionEntry({
				packageDir: params.packageDir,
				entry: builtEntry,
				label: "inferred runtime setup entry",
				requireExisting: false
			});
			if (!builtResult.ok) return builtResult;
			if (builtResult.exists) {
				foundBuiltSetupEntry = true;
				break;
			}
		}
		if (foundBuiltSetupEntry) return { ok: true };
		if (sourceEntry.exists && isTypeScriptPackageEntry(setupEntry)) return {
			ok: false,
			error: missingCompiledRuntimeEntryMessage({
				label: "package install",
				entry: setupEntry,
				candidates: builtSetupCandidates
			})
		};
		if (sourceEntry.exists) return { ok: true };
		if (builtSetupCandidates.length > 0) return {
			ok: false,
			error: missingCompiledRuntimeEntryMessage({
				label: "package install",
				entry: setupEntry,
				candidates: builtSetupCandidates
			})
		};
		return {
			ok: false,
			error: `setup entry not found: ${setupEntry}`
		};
	}
	return { ok: true };
}
function resolvePackageEntrySource(params) {
	const source = path.resolve(params.packageDir, params.entryPath);
	const rejectHardlinks = params.rejectHardlinks ?? true;
	const candidates = [source];
	const openCandidate = (absolutePath) => {
		const opened = openBoundaryFileSync({
			absolutePath,
			rootPath: params.packageDir,
			...params.packageRootRealPath !== void 0 ? { rootRealPath: params.packageRootRealPath } : {},
			boundaryLabel: "plugin package directory",
			rejectHardlinks
		});
		if (!opened.ok) return matchBoundaryFileOpenFailure(opened, {
			path: () => null,
			io: () => {
				params.diagnostics.push({
					level: "warn",
					message: `extension entry unreadable (I/O error): ${params.entryPath}`,
					source: params.sourceLabel
				});
				return null;
			},
			fallback: () => {
				params.diagnostics.push({
					level: "error",
					message: `extension entry escapes package directory: ${params.entryPath}`,
					source: params.sourceLabel
				});
				return null;
			}
		});
		const safeSource = opened.path;
		fs.closeSync(opened.fd);
		return safeSource;
	};
	if (!rejectHardlinks) {
		const builtCandidate = source.replace(/\.[^.]+$/u, ".js");
		if (builtCandidate !== source) candidates.push(builtCandidate);
	}
	for (const candidate of new Set(candidates)) {
		if (!fs.existsSync(candidate)) continue;
		return openCandidate(candidate);
	}
	return openCandidate(source);
}
function shouldInferBuiltRuntimeEntry(origin) {
	return origin === "config" || origin === "global";
}
function shouldRequireBuiltRuntimeEntry(origin) {
	return origin === "global";
}
function resolveSafePackageEntry(params) {
	const absolutePath = path.resolve(params.packageDir, params.entryPath);
	if (fs.existsSync(absolutePath)) {
		const existingSource = resolvePackageEntrySource({
			packageDir: params.packageDir,
			...params.packageRootRealPath !== void 0 ? { packageRootRealPath: params.packageRootRealPath } : {},
			entryPath: params.entryPath,
			sourceLabel: params.sourceLabel,
			diagnostics: params.diagnostics,
			rejectHardlinks: params.rejectHardlinks
		});
		if (!existingSource) return null;
		return {
			relativePath: path.relative(params.packageDir, absolutePath).replace(/\\/g, "/"),
			existingSource
		};
	}
	try {
		resolveBoundaryPathSync({
			absolutePath,
			rootPath: params.packageDir,
			...params.packageRootRealPath !== void 0 ? { rootCanonicalPath: params.packageRootRealPath } : {},
			boundaryLabel: "plugin package directory"
		});
	} catch {
		params.diagnostics.push({
			level: "error",
			message: `extension entry escapes package directory: ${params.entryPath}`,
			source: params.sourceLabel
		});
		return null;
	}
	return { relativePath: path.relative(params.packageDir, absolutePath).replace(/\\/g, "/") };
}
function resolveOptionalExistingPackageEntrySource(params) {
	const source = path.resolve(params.packageDir, params.entryPath);
	if (!fs.existsSync(source)) return { status: "missing" };
	const resolved = resolvePackageEntrySource(params);
	return resolved ? {
		status: "resolved",
		source: resolved
	} : { status: "invalid" };
}
function resolvePackageRuntimeEntrySource(params) {
	const safeEntry = resolveSafePackageEntry({
		packageDir: params.packageDir,
		...params.packageRootRealPath !== void 0 ? { packageRootRealPath: params.packageRootRealPath } : {},
		entryPath: params.entryPath,
		sourceLabel: params.sourceLabel,
		diagnostics: params.diagnostics,
		rejectHardlinks: params.rejectHardlinks
	});
	if (!safeEntry) return null;
	if (params.runtimeEntryPath) {
		const runtimeSource = resolvePackageEntrySource({
			packageDir: params.packageDir,
			...params.packageRootRealPath !== void 0 ? { packageRootRealPath: params.packageRootRealPath } : {},
			entryPath: params.runtimeEntryPath,
			sourceLabel: params.sourceLabel,
			diagnostics: params.diagnostics,
			rejectHardlinks: params.rejectHardlinks
		});
		if (runtimeSource) return runtimeSource;
		params.diagnostics.push({
			level: "error",
			message: `${params.runtimeEntryLabel ?? "runtime entry"} not found: ${params.runtimeEntryPath}`,
			source: params.sourceLabel
		});
		return null;
	}
	if (shouldInferBuiltRuntimeEntry(params.origin)) {
		const builtEntryCandidates = listBuiltRuntimeEntryCandidates(safeEntry.relativePath);
		for (const candidate of builtEntryCandidates) {
			const runtimeSource = resolveOptionalExistingPackageEntrySource({
				packageDir: params.packageDir,
				...params.packageRootRealPath !== void 0 ? { packageRootRealPath: params.packageRootRealPath } : {},
				entryPath: candidate,
				sourceLabel: params.sourceLabel,
				diagnostics: params.diagnostics,
				rejectHardlinks: params.rejectHardlinks
			});
			if (runtimeSource.status === "resolved") return runtimeSource.source;
			if (runtimeSource.status === "invalid") return null;
		}
		if (shouldRequireBuiltRuntimeEntry(params.origin) && isTypeScriptPackageEntry(safeEntry.relativePath)) {
			params.diagnostics.push({
				level: "warn",
				...params.pluginIdHint ? { pluginId: params.pluginIdHint } : {},
				message: missingCompiledRuntimeEntryMessage({
					label: "installed plugin package",
					entry: safeEntry.relativePath,
					candidates: builtEntryCandidates
				}),
				source: params.sourceLabel
			});
			return null;
		}
	}
	if (safeEntry.existingSource) return safeEntry.existingSource;
	return resolvePackageEntrySource({
		packageDir: params.packageDir,
		...params.packageRootRealPath !== void 0 ? { packageRootRealPath: params.packageRootRealPath } : {},
		entryPath: params.entryPath,
		sourceLabel: params.sourceLabel,
		diagnostics: params.diagnostics,
		rejectHardlinks: params.rejectHardlinks
	});
}
function resolvePackageSetupSource(params) {
	const packageManifest = getPackageManifestMetadata(params.manifest ?? void 0);
	const setupEntryPath = normalizeOptionalString(packageManifest?.setupEntry);
	if (!setupEntryPath) return null;
	return resolvePackageRuntimeEntrySource({
		packageDir: params.packageDir,
		...params.packageRootRealPath !== void 0 ? { packageRootRealPath: params.packageRootRealPath } : {},
		entryPath: setupEntryPath,
		runtimeEntryPath: normalizeOptionalString(packageManifest?.runtimeSetupEntry),
		runtimeEntryLabel: "runtime setup entry",
		pluginIdHint: packageManifest?.plugin?.id ?? packageManifest?.channel?.id,
		origin: params.origin,
		sourceLabel: params.sourceLabel,
		diagnostics: params.diagnostics,
		rejectHardlinks: params.rejectHardlinks
	});
}
function resolvePackageRuntimeExtensionSources(params) {
	const runtimeResolution = resolvePackageRuntimeExtensionEntries({
		manifest: params.manifest,
		extensions: params.extensions
	});
	if (!runtimeResolution.ok) {
		params.diagnostics.push({
			level: "error",
			message: runtimeResolution.error,
			source: params.sourceLabel
		});
		return [];
	}
	return params.extensions.flatMap((entryPath, index) => {
		const source = resolvePackageRuntimeEntrySource({
			packageDir: params.packageDir,
			...params.packageRootRealPath !== void 0 ? { packageRootRealPath: params.packageRootRealPath } : {},
			entryPath,
			runtimeEntryPath: runtimeResolution.runtimeExtensions[index],
			runtimeEntryLabel: "runtime extension entry",
			pluginIdHint: params.pluginIdHint,
			origin: params.origin,
			sourceLabel: params.sourceLabel,
			diagnostics: params.diagnostics,
			rejectHardlinks: params.rejectHardlinks
		});
		return source ? [source] : [];
	});
}
//#endregion
//#region src/plugins/plugin-lifecycle-trace.ts
function isPluginLifecycleTraceEnabled() {
	const raw = process.env.OPENCLAW_PLUGIN_LIFECYCLE_TRACE?.trim().toLowerCase();
	return raw === "1" || raw === "true" || raw === "yes";
}
function formatTraceValue(value) {
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return JSON.stringify(value);
}
function emitPluginLifecycleTrace(params) {
	const elapsedMs = Number(process.hrtime.bigint() - params.start) / 1e6;
	const detailText = Object.entries(params.details ?? {}).filter((entry) => entry[1] !== void 0).map(([key, value]) => `${key}=${formatTraceValue(value)}`).join(" ");
	const suffix = detailText ? ` ${detailText}` : "";
	console.error(`[plugins:lifecycle] phase=${JSON.stringify(params.phase)} ms=${elapsedMs.toFixed(2)} status=${params.status}${suffix}`);
}
function tracePluginLifecyclePhase(phase, fn, details) {
	if (!isPluginLifecycleTraceEnabled()) return fn();
	const start = process.hrtime.bigint();
	let status = "error";
	try {
		const result = fn();
		status = "ok";
		return result;
	} finally {
		emitPluginLifecycleTrace({
			phase,
			start,
			status,
			details
		});
	}
}
async function tracePluginLifecyclePhaseAsync(phase, fn, details) {
	if (!isPluginLifecycleTraceEnabled()) return fn();
	const start = process.hrtime.bigint();
	let status = "error";
	try {
		const result = await fn();
		status = "ok";
		return result;
	} finally {
		emitPluginLifecycleTrace({
			phase,
			start,
			status,
			details
		});
	}
}
//#endregion
//#region src/plugins/roots.ts
function resolvePluginSourceRoots(params) {
	const env = params.env ?? process.env;
	const workspaceRoot = params.workspaceDir ? resolveUserPath(params.workspaceDir, env) : void 0;
	return {
		stock: resolveBundledPluginsDir(env),
		global: path.join(resolveConfigDir(env), "extensions"),
		workspace: workspaceRoot ? path.join(workspaceRoot, ".openclaw", "extensions") : void 0
	};
}
function resolvePluginCacheInputs(params) {
	const env = params.env ?? process.env;
	return {
		roots: resolvePluginSourceRoots({
			workspaceDir: params.workspaceDir,
			env
		}),
		loadPaths: (params.loadPaths ?? []).filter((entry) => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean).map((entry) => resolveUserPath(entry, env))
	};
}
//#endregion
//#region src/plugins/status-dependencies.ts
function normalizeDependencyMap(raw) {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const normalized = {};
	for (const [name, spec] of Object.entries(raw)) {
		const normalizedName = name.trim();
		if (!normalizedName || typeof spec !== "string" || !spec.trim()) continue;
		normalized[normalizedName] = spec.trim();
	}
	return normalized;
}
function normalizePluginDependencySpecs(params) {
	return {
		dependencies: normalizeDependencyMap(params.dependencies),
		optionalDependencies: normalizeDependencyMap(params.optionalDependencies)
	};
}
function dependencyPathSegments(name) {
	const segments = name.split("/");
	if (segments.length === 1 && segments[0]) return [segments[0]];
	if (segments.length === 2 && segments[0]?.startsWith("@") && segments[1]) return segments;
	return null;
}
function findDependencyPackageDir(params) {
	const segments = dependencyPathSegments(params.name);
	if (!segments) return;
	let current = path.resolve(params.fromDir);
	while (true) {
		const candidate = path.join(current, "node_modules", ...segments);
		if (fs.existsSync(candidate)) return candidate;
		const parent = path.dirname(current);
		if (parent === current) return;
		current = parent;
	}
}
function buildDependencyEntries(params) {
	return Object.entries(params.dependencies).toSorted(([left], [right]) => left.localeCompare(right)).map(([name, spec]) => {
		const resolvedPath = params.rootDir ? findDependencyPackageDir({
			fromDir: params.rootDir,
			name
		}) : void 0;
		const entry = {
			name,
			spec,
			installed: resolvedPath !== void 0,
			optional: params.optional
		};
		if (resolvedPath) entry.resolvedPath = resolvedPath;
		return entry;
	});
}
function buildPluginDependencyStatus(params) {
	const dependencies = buildDependencyEntries({
		rootDir: params.rootDir,
		dependencies: params.dependencies ?? {},
		optional: false
	});
	const optionalDependencies = buildDependencyEntries({
		rootDir: params.rootDir,
		dependencies: params.optionalDependencies ?? {},
		optional: true
	});
	const missing = dependencies.filter((entry) => !entry.installed).map((entry) => entry.name);
	const missingOptional = optionalDependencies.filter((entry) => !entry.installed).map((entry) => entry.name);
	const requiredInstalled = missing.length === 0;
	const optionalInstalled = missingOptional.length === 0;
	return {
		hasDependencies: dependencies.length > 0 || optionalDependencies.length > 0,
		installed: requiredInstalled,
		requiredInstalled,
		optionalInstalled,
		missing,
		missingOptional,
		dependencies,
		optionalDependencies
	};
}
//#endregion
//#region src/plugins/discovery.ts
const EXTENSION_EXTS = new Set([
	".ts",
	".js",
	".mts",
	".cts",
	".mjs",
	".cjs"
]);
const SCANNED_DIRECTORY_IGNORE_NAMES = new Set([
	".git",
	".hg",
	".svn",
	".turbo",
	".yarn",
	".yarn-cache",
	"build",
	"coverage",
	"dist",
	"node_modules"
]);
function currentUid(overrideUid) {
	if (overrideUid !== void 0) return overrideUid;
	if (process.platform === "win32") return null;
	if (typeof process.getuid !== "function") return null;
	return process.getuid();
}
function checkSourceEscapesRoot(params) {
	const sourceRealPath = safeRealpathSync(params.source, params.realpathCache);
	const rootRealPath = safeRealpathSync(params.rootDir, params.realpathCache);
	if (!sourceRealPath || !rootRealPath) return null;
	if (isPathInside(rootRealPath, sourceRealPath)) return null;
	return {
		reason: "source_escapes_root",
		sourcePath: params.source,
		rootPath: params.rootDir,
		targetPath: params.source,
		sourceRealPath,
		rootRealPath
	};
}
function checkPathStatAndPermissions(params) {
	if (process.platform === "win32") return null;
	const pathsToCheck = [params.rootDir, params.source];
	const seen = /* @__PURE__ */ new Set();
	for (const targetPath of pathsToCheck) {
		const normalized = path.resolve(targetPath);
		if (seen.has(normalized)) continue;
		seen.add(normalized);
		let stat = safeStatSync(targetPath);
		if (!stat) return {
			reason: "path_stat_failed",
			sourcePath: params.source,
			rootPath: params.rootDir,
			targetPath
		};
		let modeBits = stat.mode & 511;
		if ((modeBits & 2) !== 0 && params.origin === "bundled") try {
			fs.chmodSync(targetPath, modeBits & -19);
			const repairedStat = safeStatSync(targetPath);
			if (!repairedStat) return {
				reason: "path_stat_failed",
				sourcePath: params.source,
				rootPath: params.rootDir,
				targetPath
			};
			stat = repairedStat;
			modeBits = repairedStat.mode & 511;
		} catch {}
		if ((modeBits & 2) !== 0) return {
			reason: "path_world_writable",
			sourcePath: params.source,
			rootPath: params.rootDir,
			targetPath,
			modeBits
		};
		if (params.origin !== "bundled" && params.uid !== null && typeof stat.uid === "number" && stat.uid !== params.uid && stat.uid !== 0) return {
			reason: "path_suspicious_ownership",
			sourcePath: params.source,
			rootPath: params.rootDir,
			targetPath,
			foundUid: stat.uid,
			expectedUid: params.uid
		};
	}
	return null;
}
function findCandidateBlockIssue(params) {
	const escaped = checkSourceEscapesRoot({
		source: params.source,
		rootDir: params.rootDir,
		realpathCache: params.realpathCache
	});
	if (escaped) return escaped;
	return checkPathStatAndPermissions({
		source: params.source,
		rootDir: params.rootDir,
		origin: params.origin,
		uid: currentUid(params.ownershipUid)
	});
}
function formatCandidateBlockMessage(issue) {
	if (issue.reason === "source_escapes_root") return `blocked plugin candidate: source escapes plugin root (${issue.sourcePath} -> ${issue.sourceRealPath}; root=${issue.rootRealPath})`;
	if (issue.reason === "path_stat_failed") return `blocked plugin candidate: cannot stat path (${issue.targetPath})`;
	if (issue.reason === "path_world_writable") return `blocked plugin candidate: world-writable path (${issue.targetPath}, mode=${formatPosixMode(issue.modeBits ?? 0)})`;
	return `blocked plugin candidate: suspicious ownership (${issue.targetPath}, uid=${issue.foundUid}, expected uid=${issue.expectedUid} or root)`;
}
function isUnsafePluginCandidate(params) {
	const issue = findCandidateBlockIssue({
		source: params.source,
		rootDir: params.rootDir,
		origin: params.origin,
		ownershipUid: params.ownershipUid,
		realpathCache: params.realpathCache
	});
	if (!issue) return false;
	params.diagnostics.push({
		level: "warn",
		...params.pluginId ? { pluginId: params.pluginId } : {},
		source: issue.targetPath,
		message: formatCandidateBlockMessage(issue)
	});
	return true;
}
function isExtensionFile(filePath) {
	const ext = path.extname(filePath);
	if (!EXTENSION_EXTS.has(ext)) return false;
	if (filePath.endsWith(".d.ts")) return false;
	const baseName = normalizeLowercaseStringOrEmpty(path.basename(filePath));
	return !baseName.includes(".test.") && !baseName.includes(".live.test.") && !baseName.includes(".e2e.test.");
}
function shouldIgnoreScannedDirectory(dirName) {
	const normalized = normalizeLowercaseStringOrEmpty(dirName);
	if (!normalized) return true;
	if (SCANNED_DIRECTORY_IGNORE_NAMES.has(normalized)) return true;
	if (normalized.endsWith(".bak")) return true;
	if (normalized.includes(".backup-")) return true;
	if (normalized.includes(".disabled")) return true;
	return false;
}
function resolveScannedEntryType(entry, fullPath) {
	if (entry.isFile()) return "file";
	if (entry.isDirectory()) return "directory";
	if (!entry.isSymbolicLink()) return null;
	const stat = safeStatSync(fullPath);
	if (!stat) return null;
	if (stat.isFile()) return "file";
	if (stat.isDirectory()) return "directory";
	return null;
}
function resolvesToSameDirectory(left, right, realpathCache) {
	if (!left || !right) return false;
	const leftRealPath = safeRealpathSync(left, realpathCache);
	const rightRealPath = safeRealpathSync(right, realpathCache);
	if (leftRealPath && rightRealPath) return leftRealPath === rightRealPath;
	return path.resolve(left) === path.resolve(right);
}
function createDiscoveryResult() {
	return {
		candidates: [],
		diagnostics: []
	};
}
function mergeDiscoveryResult(target, source, seenSources, seenDiagnostics) {
	for (const candidate of source.candidates) {
		const key = candidate.source;
		if (seenSources.has(key)) continue;
		seenSources.add(key);
		target.candidates.push(candidate);
	}
	for (const diagnostic of source.diagnostics) {
		const key = [
			diagnostic.level,
			diagnostic.pluginId ?? "",
			diagnostic.source ?? "",
			diagnostic.message
		].join("\0");
		if (seenDiagnostics.has(key)) continue;
		seenDiagnostics.add(key);
		target.diagnostics.push(diagnostic);
	}
}
function collectInstalledPluginRecordPaths(installRecords, env) {
	const paths = [];
	const seen = /* @__PURE__ */ new Set();
	for (const record of Object.values(installRecords ?? {})) {
		const rawPath = typeof record.installPath === "string" && record.installPath.trim() ? record.installPath : typeof record.sourcePath === "string" && record.sourcePath.trim() ? record.sourcePath : void 0;
		if (!rawPath) continue;
		const resolved = resolveUserPath(rawPath, env);
		if (seen.has(resolved) || !fs.existsSync(resolved)) continue;
		seen.add(resolved);
		paths.push(resolved);
	}
	return paths;
}
function readPackageManifest(dir, rejectHardlinks = true, rootRealPath) {
	const opened = openBoundaryFileSync({
		absolutePath: path.join(dir, "package.json"),
		rootPath: dir,
		...rootRealPath !== void 0 ? { rootRealPath } : {},
		boundaryLabel: "plugin package directory",
		rejectHardlinks
	});
	if (!opened.ok) return null;
	try {
		const raw = fs.readFileSync(opened.fd, "utf-8");
		return JSON.parse(raw);
	} catch {
		return null;
	} finally {
		fs.closeSync(opened.fd);
	}
}
function readTrustedPackageManifest(dir) {
	try {
		return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
	} catch {
		return null;
	}
}
function readCandidatePackageManifest(params) {
	if (params.origin === "bundled") return readTrustedPackageManifest(params.dir);
	return readPackageManifest(params.dir, params.rejectHardlinks, params.rootRealPath);
}
function deriveIdHint(params) {
	const base = path.basename(params.filePath, path.extname(params.filePath));
	const rawManifestId = params.manifestId?.trim();
	if (rawManifestId) return params.hasMultipleExtensions ? `${rawManifestId}/${base}` : rawManifestId;
	const rawPackageName = params.packageName?.trim();
	if (!rawPackageName) return base;
	const unscoped = rawPackageName.includes("/") ? rawPackageName.split("/").pop() ?? rawPackageName : rawPackageName;
	const normalizedPackageId = unscoped.endsWith("-provider") && unscoped.length > 9 ? unscoped.slice(0, -9) : unscoped;
	if (!params.hasMultipleExtensions) return normalizedPackageId;
	return `${normalizedPackageId}/${base}`;
}
function derivePackagePluginIdHint(params) {
	const rawManifestId = params.manifestId?.trim();
	if (rawManifestId) return rawManifestId;
	const rawPackageName = params.packageName?.trim();
	if (!rawPackageName) return;
	const unscoped = rawPackageName.includes("/") ? rawPackageName.split("/").pop() ?? rawPackageName : rawPackageName;
	return unscoped.endsWith("-provider") && unscoped.length > 9 ? unscoped.slice(0, -9) : unscoped;
}
function resolveIdHintManifestId(rootDir, rejectHardlinks, rootRealPath) {
	const manifest = loadPluginManifest(rootDir, rejectHardlinks, rootRealPath);
	return manifest.ok ? manifest.manifest.id : void 0;
}
function addCandidate(params) {
	const resolved = path.resolve(params.source);
	if (params.seen.has(resolved)) return;
	const resolvedRoot = safeRealpathSync(params.rootDir, params.realpathCache) ?? path.resolve(params.rootDir);
	if (isUnsafePluginCandidate({
		source: resolved,
		rootDir: resolvedRoot,
		origin: params.origin,
		pluginId: params.idHint,
		diagnostics: params.diagnostics,
		ownershipUid: params.ownershipUid,
		realpathCache: params.realpathCache
	})) {
		params.seen.add(resolved);
		return;
	}
	params.seen.add(resolved);
	const manifest = params.manifest ?? null;
	const packageDependencies = normalizePluginDependencySpecs({
		dependencies: manifest?.dependencies,
		optionalDependencies: manifest?.optionalDependencies
	});
	params.candidates.push({
		idHint: params.idHint,
		source: resolved,
		setupSource: params.setupSource,
		rootDir: resolvedRoot,
		origin: params.origin,
		format: params.format ?? "openclaw",
		bundleFormat: params.bundleFormat,
		workspaceDir: params.workspaceDir,
		packageName: normalizeOptionalString(manifest?.name),
		packageVersion: normalizeOptionalString(manifest?.version),
		packageDescription: normalizeOptionalString(manifest?.description),
		packageDir: params.packageDir,
		packageManifest: getPackageManifestMetadata(manifest ?? void 0),
		packageDependencies: packageDependencies.dependencies,
		packageOptionalDependencies: packageDependencies.optionalDependencies,
		bundledManifest: params.bundledManifest,
		bundledManifestPath: params.bundledManifestPath
	});
}
function discoverBundleInRoot(params) {
	const bundleFormat = detectBundleManifestFormat(params.rootDir);
	if (!bundleFormat) return "none";
	const rootRealPath = safeRealpathSync(params.rootDir, params.realpathCache) ?? void 0;
	const bundleManifest = loadBundleManifest({
		rootDir: params.rootDir,
		...rootRealPath !== void 0 ? { rootRealPath } : {},
		bundleFormat,
		rejectHardlinks: params.origin !== "bundled"
	});
	if (!bundleManifest.ok) {
		params.diagnostics.push({
			level: "error",
			message: bundleManifest.error,
			source: bundleManifest.manifestPath
		});
		return "invalid";
	}
	addCandidate({
		candidates: params.candidates,
		diagnostics: params.diagnostics,
		seen: params.seen,
		idHint: bundleManifest.manifest.id,
		source: params.rootDir,
		rootDir: params.rootDir,
		origin: params.origin,
		format: "bundle",
		bundleFormat,
		ownershipUid: params.ownershipUid,
		workspaceDir: params.workspaceDir,
		manifest: params.manifest,
		packageDir: params.rootDir,
		realpathCache: params.realpathCache
	});
	return "added";
}
function discoverInDirectory(params) {
	if (!fs.existsSync(params.dir)) return;
	const resolvedDir = safeRealpathSync(params.dir, params.realpathCache) ?? path.resolve(params.dir);
	if (params.recurseDirectories) {
		if (params.visitedDirectories?.has(resolvedDir)) return;
		params.visitedDirectories?.add(resolvedDir);
	}
	let entries = [];
	try {
		entries = fs.readdirSync(params.dir, { withFileTypes: true });
	} catch (err) {
		params.diagnostics.push({
			level: "warn",
			message: `failed to read extensions dir: ${params.dir} (${String(err)})`,
			source: params.dir
		});
		return;
	}
	for (const entry of entries) {
		const fullPath = path.join(params.dir, entry.name);
		const entryType = resolveScannedEntryType(entry, fullPath);
		if (entryType === "file") {
			if (!isExtensionFile(fullPath)) continue;
			addCandidate({
				candidates: params.candidates,
				diagnostics: params.diagnostics,
				seen: params.seen,
				idHint: path.basename(entry.name, path.extname(entry.name)),
				source: fullPath,
				rootDir: path.dirname(fullPath),
				origin: params.origin,
				ownershipUid: params.ownershipUid,
				workspaceDir: params.workspaceDir,
				realpathCache: params.realpathCache
			});
			continue;
		}
		if (entryType !== "directory") continue;
		if (params.skipDirectories?.has(entry.name)) continue;
		if (shouldIgnoreScannedDirectory(entry.name)) continue;
		const rejectHardlinks = params.origin !== "bundled";
		const fullPathRealPath = safeRealpathSync(fullPath, params.realpathCache) ?? void 0;
		const manifest = readCandidatePackageManifest({
			dir: fullPath,
			origin: params.origin,
			rejectHardlinks,
			...fullPathRealPath !== void 0 ? { rootRealPath: fullPathRealPath } : {}
		});
		const extensionResolution = resolvePackageExtensionEntries(manifest ?? void 0);
		const extensions = extensionResolution.status === "ok" ? extensionResolution.entries : [];
		const manifestId = resolveIdHintManifestId(fullPath, rejectHardlinks, fullPathRealPath);
		const setupSource = resolvePackageSetupSource({
			packageDir: fullPath,
			...fullPathRealPath !== void 0 ? { packageRootRealPath: fullPathRealPath } : {},
			manifest,
			origin: params.origin,
			sourceLabel: fullPath,
			diagnostics: params.diagnostics,
			rejectHardlinks
		});
		if (extensions.length > 0) {
			const resolvedRuntimeSources = resolvePackageRuntimeExtensionSources({
				packageDir: fullPath,
				...fullPathRealPath !== void 0 ? { packageRootRealPath: fullPathRealPath } : {},
				manifest,
				extensions,
				origin: params.origin,
				pluginIdHint: derivePackagePluginIdHint({
					manifestId,
					packageName: manifest?.name
				}),
				sourceLabel: fullPath,
				diagnostics: params.diagnostics,
				rejectHardlinks
			});
			for (const resolved of resolvedRuntimeSources) addCandidate({
				candidates: params.candidates,
				diagnostics: params.diagnostics,
				seen: params.seen,
				idHint: deriveIdHint({
					filePath: resolved,
					manifestId,
					packageName: manifest?.name,
					hasMultipleExtensions: extensions.length > 1
				}),
				source: resolved,
				...setupSource ? { setupSource } : {},
				rootDir: fullPath,
				origin: params.origin,
				ownershipUid: params.ownershipUid,
				workspaceDir: params.workspaceDir,
				manifest,
				packageDir: fullPath,
				realpathCache: params.realpathCache
			});
			continue;
		}
		if (discoverBundleInRoot({
			rootDir: fullPath,
			origin: params.origin,
			ownershipUid: params.ownershipUid,
			workspaceDir: params.workspaceDir,
			manifest,
			candidates: params.candidates,
			diagnostics: params.diagnostics,
			seen: params.seen,
			realpathCache: params.realpathCache
		}) === "added") continue;
		const indexFile = [...DEFAULT_PLUGIN_ENTRY_CANDIDATES].map((candidate) => path.join(fullPath, candidate)).find((candidate) => fs.existsSync(candidate));
		if (indexFile && isExtensionFile(indexFile)) {
			addCandidate({
				candidates: params.candidates,
				diagnostics: params.diagnostics,
				seen: params.seen,
				idHint: manifestId ?? entry.name,
				source: indexFile,
				...setupSource ? { setupSource } : {},
				rootDir: fullPath,
				origin: params.origin,
				ownershipUid: params.ownershipUid,
				workspaceDir: params.workspaceDir,
				manifest,
				packageDir: fullPath,
				realpathCache: params.realpathCache
			});
			continue;
		}
		if (params.recurseDirectories) discoverInDirectory({
			...params,
			dir: fullPath
		});
	}
}
function hasDiscoverablePluginTree(pluginsDir) {
	try {
		return fs.readdirSync(pluginsDir, { withFileTypes: true }).some((entry) => {
			if (!entry.isDirectory()) return false;
			const pluginDir = path.join(pluginsDir, entry.name);
			return fs.existsSync(path.join(pluginDir, "package.json")) || fs.existsSync(path.join(pluginDir, "openclaw.plugin.json"));
		});
	} catch {
		return false;
	}
}
function isSourceCheckoutExtensionsDir(extensionsDir) {
	const packageRoot = path.dirname(extensionsDir);
	return fs.existsSync(path.join(packageRoot, ".git")) && fs.existsSync(path.join(packageRoot, "pnpm-workspace.yaml")) && fs.existsSync(path.join(packageRoot, "src")) && fs.existsSync(extensionsDir) && hasDiscoverablePluginTree(extensionsDir);
}
function resolveBundledSourceCheckoutExtensionsDir(bundledRoot) {
	if (!bundledRoot) return;
	const legacyRoot = buildLegacyBundledRootPath(bundledRoot);
	if (!legacyRoot || !isSourceCheckoutExtensionsDir(legacyRoot)) return;
	return legacyRoot;
}
function readChildDirectoryNames(dir) {
	if (!dir || !fs.existsSync(dir)) return /* @__PURE__ */ new Set();
	try {
		return new Set(fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name));
	} catch {
		return /* @__PURE__ */ new Set();
	}
}
function discoverFromPath(params) {
	const resolved = resolveUserPath(params.rawPath, params.env);
	if (!fs.existsSync(resolved)) {
		params.diagnostics.push({
			level: "error",
			message: `plugin path not found: ${resolved}`,
			source: resolved
		});
		return;
	}
	const stat = fs.statSync(resolved);
	if (stat.isFile()) {
		if (!isExtensionFile(resolved)) {
			params.diagnostics.push({
				level: "error",
				message: `plugin path is not a supported file: ${resolved}`,
				source: resolved
			});
			return;
		}
		addCandidate({
			candidates: params.candidates,
			diagnostics: params.diagnostics,
			seen: params.seen,
			idHint: path.basename(resolved, path.extname(resolved)),
			source: resolved,
			rootDir: path.dirname(resolved),
			origin: params.origin,
			ownershipUid: params.ownershipUid,
			workspaceDir: params.workspaceDir,
			realpathCache: params.realpathCache
		});
		return;
	}
	if (stat.isDirectory()) {
		const rejectHardlinks = params.origin !== "bundled";
		const resolvedRealPath = safeRealpathSync(resolved, params.realpathCache) ?? void 0;
		const manifest = readCandidatePackageManifest({
			dir: resolved,
			origin: params.origin,
			rejectHardlinks,
			...resolvedRealPath !== void 0 ? { rootRealPath: resolvedRealPath } : {}
		});
		const extensionResolution = resolvePackageExtensionEntries(manifest ?? void 0);
		const extensions = extensionResolution.status === "ok" ? extensionResolution.entries : [];
		const manifestId = resolveIdHintManifestId(resolved, rejectHardlinks, resolvedRealPath);
		const setupSource = resolvePackageSetupSource({
			packageDir: resolved,
			...resolvedRealPath !== void 0 ? { packageRootRealPath: resolvedRealPath } : {},
			manifest,
			origin: params.origin,
			sourceLabel: resolved,
			diagnostics: params.diagnostics,
			rejectHardlinks
		});
		if (extensions.length > 0) {
			const resolvedRuntimeSources = resolvePackageRuntimeExtensionSources({
				packageDir: resolved,
				...resolvedRealPath !== void 0 ? { packageRootRealPath: resolvedRealPath } : {},
				manifest,
				extensions,
				origin: params.origin,
				pluginIdHint: derivePackagePluginIdHint({
					manifestId,
					packageName: manifest?.name
				}),
				sourceLabel: resolved,
				diagnostics: params.diagnostics,
				rejectHardlinks
			});
			for (const source of resolvedRuntimeSources) addCandidate({
				candidates: params.candidates,
				diagnostics: params.diagnostics,
				seen: params.seen,
				idHint: deriveIdHint({
					filePath: source,
					manifestId,
					packageName: manifest?.name,
					hasMultipleExtensions: extensions.length > 1
				}),
				source,
				...setupSource ? { setupSource } : {},
				rootDir: resolved,
				origin: params.origin,
				ownershipUid: params.ownershipUid,
				workspaceDir: params.workspaceDir,
				manifest,
				packageDir: resolved,
				realpathCache: params.realpathCache
			});
			return;
		}
		if (discoverBundleInRoot({
			rootDir: resolved,
			origin: params.origin,
			ownershipUid: params.ownershipUid,
			workspaceDir: params.workspaceDir,
			manifest,
			candidates: params.candidates,
			diagnostics: params.diagnostics,
			seen: params.seen,
			realpathCache: params.realpathCache
		}) === "added") return;
		const indexFile = [...DEFAULT_PLUGIN_ENTRY_CANDIDATES].map((candidate) => path.join(resolved, candidate)).find((candidate) => fs.existsSync(candidate));
		if (indexFile && isExtensionFile(indexFile)) {
			addCandidate({
				candidates: params.candidates,
				diagnostics: params.diagnostics,
				seen: params.seen,
				idHint: manifestId ?? path.basename(resolved),
				source: indexFile,
				...setupSource ? { setupSource } : {},
				rootDir: resolved,
				origin: params.origin,
				ownershipUid: params.ownershipUid,
				workspaceDir: params.workspaceDir,
				manifest,
				packageDir: resolved,
				realpathCache: params.realpathCache
			});
			return;
		}
		discoverInDirectory({
			dir: resolved,
			origin: params.origin,
			ownershipUid: params.ownershipUid,
			workspaceDir: params.workspaceDir,
			candidates: params.candidates,
			diagnostics: params.diagnostics,
			seen: params.seen,
			realpathCache: params.realpathCache
		});
		return;
	}
}
function discoverOpenClawPlugins(params) {
	const env = params.env ?? process.env;
	const workspaceDir = normalizeOptionalString(params.workspaceDir);
	const workspaceRoot = workspaceDir ? resolveUserPath(workspaceDir, env) : void 0;
	const roots = resolvePluginSourceRoots({
		workspaceDir: workspaceRoot,
		env
	});
	const scopedResult = tracePluginLifecyclePhase("discovery scan", () => {
		const result = createDiscoveryResult();
		const seen = /* @__PURE__ */ new Set();
		const realpathCache = /* @__PURE__ */ new Map();
		const extra = params.extraPaths ?? [];
		for (const extraPath of extra) {
			if (typeof extraPath !== "string") continue;
			const trimmed = extraPath.trim();
			if (!trimmed) continue;
			const bundledAlias = resolvePackagedBundledLoadPathAlias({
				bundledRoot: roots.stock,
				loadPath: resolveUserPath(trimmed, env)
			});
			if (bundledAlias) {
				result.diagnostics.push({
					level: "warn",
					source: trimmed,
					message: `ignored plugins.load.paths entry that points at OpenClaw's ${bundledAlias.kind} bundled plugin directory; remove this redundant path or run openclaw doctor --fix`
				});
				continue;
			}
			discoverFromPath({
				rawPath: trimmed,
				origin: "config",
				ownershipUid: params.ownershipUid,
				workspaceDir,
				env,
				candidates: result.candidates,
				diagnostics: result.diagnostics,
				seen,
				realpathCache
			});
		}
		const workspaceMatchesBundledRoot = resolvesToSameDirectory(workspaceRoot, roots.stock, realpathCache);
		if (roots.workspace && workspaceRoot && !workspaceMatchesBundledRoot) discoverInDirectory({
			dir: roots.workspace,
			origin: "workspace",
			ownershipUid: params.ownershipUid,
			workspaceDir: workspaceRoot,
			candidates: result.candidates,
			diagnostics: result.diagnostics,
			seen,
			realpathCache
		});
		return result;
	}, {
		scope: "scoped",
		extraPathCount: params.extraPaths?.length ?? 0
	});
	const sharedResult = tracePluginLifecyclePhase("discovery scan", () => {
		const result = createDiscoveryResult();
		const seen = /* @__PURE__ */ new Set();
		const realpathCache = /* @__PURE__ */ new Map();
		for (const sourceOverlayDir of listBundledSourceOverlayDirs({
			bundledRoot: roots.stock,
			env
		})) {
			discoverFromPath({
				rawPath: sourceOverlayDir,
				origin: "bundled",
				ownershipUid: params.ownershipUid,
				workspaceDir,
				env,
				candidates: result.candidates,
				diagnostics: result.diagnostics,
				seen,
				realpathCache
			});
			result.diagnostics.push({
				level: "warn",
				source: sourceOverlayDir,
				message: "using bind-mounted bundled plugin source overlay; this source overrides the packaged dist bundle for the same plugin id"
			});
		}
		const sourceCheckoutDependencyDiagnostic = resolveSourceCheckoutDependencyDiagnostic(env);
		if (sourceCheckoutDependencyDiagnostic) result.diagnostics.push({
			level: "warn",
			source: sourceCheckoutDependencyDiagnostic.source,
			message: sourceCheckoutDependencyDiagnostic.message
		});
		if (roots.stock) discoverInDirectory({
			dir: roots.stock,
			origin: "bundled",
			ownershipUid: params.ownershipUid,
			candidates: result.candidates,
			diagnostics: result.diagnostics,
			seen,
			realpathCache
		});
		const sourceCheckoutExtensionsDir = resolveBundledSourceCheckoutExtensionsDir(roots.stock);
		const sourceCheckoutMatchesBundledRoot = resolvesToSameDirectory(sourceCheckoutExtensionsDir, roots.stock, realpathCache);
		if (sourceCheckoutExtensionsDir && !sourceCheckoutMatchesBundledRoot) discoverInDirectory({
			dir: sourceCheckoutExtensionsDir,
			origin: "bundled",
			ownershipUid: params.ownershipUid,
			candidates: result.candidates,
			diagnostics: result.diagnostics,
			seen,
			realpathCache,
			skipDirectories: readChildDirectoryNames(roots.stock)
		});
		for (const installedPath of collectInstalledPluginRecordPaths(params.installRecords, env)) discoverFromPath({
			rawPath: installedPath,
			origin: "global",
			ownershipUid: params.ownershipUid,
			workspaceDir,
			env,
			candidates: result.candidates,
			diagnostics: result.diagnostics,
			seen,
			realpathCache
		});
		discoverInDirectory({
			dir: roots.global,
			origin: "global",
			ownershipUid: params.ownershipUid,
			candidates: result.candidates,
			diagnostics: result.diagnostics,
			seen,
			realpathCache
		});
		return result;
	}, { scope: "shared" });
	const result = createDiscoveryResult();
	const seenSources = /* @__PURE__ */ new Set();
	const seenDiagnostics = /* @__PURE__ */ new Set();
	mergeDiscoveryResult(result, scopedResult, seenSources, seenDiagnostics);
	mergeDiscoveryResult(result, sharedResult, seenSources, seenDiagnostics);
	return result;
}
//#endregion
export { compareOpenClawReleaseVersions as A, getPackageManifestMetadata as C, planManifestModelCatalogRows as D, planProviderIndexModelCatalogRows as E, parseRegistryNpmSpec as F, validateRegistryNpmSpec as I, isExactSemverVersion as M, isPrereleaseResolutionAllowed as N, planManifestModelCatalogSuppressions as O, isPrereleaseSemverVersion as P, PLUGIN_MANIFEST_FILENAME as S, resolvePackageExtensionEntries as T, detectBundleManifestFormat as _, resolvePluginSourceRoots as a, normalizeBundlePathList as b, validatePackageExtensionEntriesForInstall as c, isPathInside as d, safeRealpathSync as f, CURSOR_BUNDLE_MANIFEST_RELATIVE_PATH as g, CODEX_BUNDLE_MANIFEST_RELATIVE_PATH as h, resolvePluginCacheInputs as i, formatPrereleaseResolutionError as j, loadOpenClawProviderIndex as k, buildBundledPluginLoadPathAliases as l, CLAUDE_BUNDLE_MANIFEST_RELATIVE_PATH as m, buildPluginDependencyStatus as n, tracePluginLifecyclePhase as o, safeStatSync as p, normalizePluginDependencySpecs as r, tracePluginLifecyclePhaseAsync as s, discoverOpenClawPlugins as t, normalizeBundledLookupPath as u, loadBundleManifest as v, loadPluginManifest as w, DEFAULT_PLUGIN_ENTRY_CANDIDATES as x, mergeBundlePathLists as y };
