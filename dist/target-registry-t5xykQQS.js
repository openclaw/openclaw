import { c as isRecord } from "./utils-sBTEdeml.js";
import { i as loadPluginMetadataSnapshot } from "./plugin-metadata-snapshot-C-_V3F5M.js";
import { v as getCurrentPluginMetadataSnapshot } from "./plugin-registry-CgH_ZSlH.js";
import { n as loadChannelSecretContractApiForRecord, t as loadChannelSecretContractApi } from "./channel-contract-api-BKyJzTiE.js";
import { i as parseDotPath } from "./shared-Cv5g0_Ch.js";
import { n as getPath } from "./path-utils-BCEW_1WB.js";
//#region src/secrets/target-registry-data.ts
const SECRET_INPUT_SHAPE = "secret_input";
const SIBLING_REF_SHAPE = "sibling_ref";
const WEB_PROVIDER_SECRET_CONFIGS = [{
	contract: "webSearchProviders",
	configPath: "webSearch.apiKey"
}, {
	contract: "webFetchProviders",
	configPath: "webFetch.apiKey"
}];
function createPluginOpenClawConfigSecretTargetEntry(pluginId, configPath) {
	const pathPattern = [
		"plugins",
		"entries",
		pluginId,
		"config",
		...configPath.split(".")
	].join(".");
	return {
		id: pathPattern,
		targetType: pathPattern,
		configFile: "openclaw.json",
		pathPattern,
		secretShape: SECRET_INPUT_SHAPE,
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	};
}
function hasSensitiveConfigHint(plugin, configPath) {
	return plugin.configUiHints?.[configPath]?.sensitive === true;
}
function hasWebProviderContract(plugin, contract) {
	return (plugin.contracts?.[contract]?.length ?? 0) > 0;
}
function listBundledWebProviderSecretTargetRegistryEntries(bundledPlugins) {
	const entries = [];
	for (const record of bundledPlugins) for (const config of WEB_PROVIDER_SECRET_CONFIGS) if (hasWebProviderContract(record, config.contract) && hasSensitiveConfigHint(record, config.configPath)) entries.push(createPluginOpenClawConfigSecretTargetEntry(record.id, config.configPath));
	return entries.toSorted((left, right) => left.id.localeCompare(right.id));
}
function listBundledPluginConfigSecretTargetRegistryEntries(bundledPlugins) {
	const entries = [];
	const seen = /* @__PURE__ */ new Set();
	for (const record of bundledPlugins) {
		const secretInputs = record.configContracts?.secretInputs?.paths ?? [];
		for (const secretInput of secretInputs) {
			const entry = createPluginOpenClawConfigSecretTargetEntry(record.id, secretInput.path);
			const key = `${entry.configFile}:${entry.pathPattern}`;
			if (seen.has(key)) continue;
			seen.add(key);
			entries.push(entry);
		}
	}
	return entries.toSorted((left, right) => left.id.localeCompare(right.id));
}
function listChannelSecretTargetRegistryEntries(channelPlugins) {
	const entries = [];
	for (const record of channelPlugins) {
		if (record.channels.length === 0) continue;
		try {
			const contractApi = loadChannelSecretContractApiForRecord(record);
			entries.push(...contractApi?.secretTargetRegistryEntries ?? []);
		} catch {}
	}
	return entries;
}
const CORE_SECRET_TARGET_REGISTRY = [
	{
		id: "auth-profiles.api_key.key",
		targetType: "auth-profiles.api_key.key",
		configFile: "auth-profiles.json",
		pathPattern: "profiles.*.key",
		refPathPattern: "profiles.*.keyRef",
		secretShape: SIBLING_REF_SHAPE,
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true,
		authProfileType: "api_key"
	},
	{
		id: "auth-profiles.token.token",
		targetType: "auth-profiles.token.token",
		configFile: "auth-profiles.json",
		pathPattern: "profiles.*.token",
		refPathPattern: "profiles.*.tokenRef",
		secretShape: SIBLING_REF_SHAPE,
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true,
		authProfileType: "token"
	},
	{
		id: "agents.defaults.memorySearch.remote.apiKey",
		targetType: "agents.defaults.memorySearch.remote.apiKey",
		configFile: "openclaw.json",
		pathPattern: "agents.defaults.memorySearch.remote.apiKey",
		secretShape: SECRET_INPUT_SHAPE,
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "agents.list[].memorySearch.remote.apiKey",
		targetType: "agents.list[].memorySearch.remote.apiKey",
		configFile: "openclaw.json",
		pathPattern: "agents.list[].memorySearch.remote.apiKey",
		secretShape: SECRET_INPUT_SHAPE,
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "cron.webhookToken",
		targetType: "cron.webhookToken",
		configFile: "openclaw.json",
		pathPattern: "cron.webhookToken",
		secretShape: SECRET_INPUT_SHAPE,
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "gateway.auth.token",
		targetType: "gateway.auth.token",
		configFile: "openclaw.json",
		pathPattern: "gateway.auth.token",
		secretShape: SECRET_INPUT_SHAPE,
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "gateway.auth.password",
		targetType: "gateway.auth.password",
		configFile: "openclaw.json",
		pathPattern: "gateway.auth.password",
		secretShape: SECRET_INPUT_SHAPE,
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "gateway.remote.password",
		targetType: "gateway.remote.password",
		configFile: "openclaw.json",
		pathPattern: "gateway.remote.password",
		secretShape: SECRET_INPUT_SHAPE,
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "gateway.remote.token",
		targetType: "gateway.remote.token",
		configFile: "openclaw.json",
		pathPattern: "gateway.remote.token",
		secretShape: SECRET_INPUT_SHAPE,
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "messages.tts.providers.*.apiKey",
		targetType: "messages.tts.providers.*.apiKey",
		configFile: "openclaw.json",
		pathPattern: "messages.tts.providers.*.apiKey",
		secretShape: SECRET_INPUT_SHAPE,
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true,
		providerIdPathSegmentIndex: 3
	},
	{
		id: "agents.list[].tts.providers.*.apiKey",
		targetType: "agents.list[].tts.providers.*.apiKey",
		configFile: "openclaw.json",
		pathPattern: "agents.list[].tts.providers.*.apiKey",
		secretShape: SECRET_INPUT_SHAPE,
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: false,
		includeInAudit: true,
		providerIdPathSegmentIndex: 4
	},
	{
		id: "models.providers.*.apiKey",
		targetType: "models.providers.apiKey",
		targetTypeAliases: ["models.providers.*.apiKey"],
		configFile: "openclaw.json",
		pathPattern: "models.providers.*.apiKey",
		secretShape: SECRET_INPUT_SHAPE,
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true,
		providerIdPathSegmentIndex: 2,
		trackProviderShadowing: true
	},
	{
		id: "models.providers.*.headers.*",
		targetType: "models.providers.headers",
		targetTypeAliases: ["models.providers.*.headers.*"],
		configFile: "openclaw.json",
		pathPattern: "models.providers.*.headers.*",
		secretShape: SECRET_INPUT_SHAPE,
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true,
		providerIdPathSegmentIndex: 2
	},
	{
		id: "models.providers.*.request.headers.*",
		targetType: "models.providers.request.headers",
		targetTypeAliases: ["models.providers.*.request.headers.*"],
		configFile: "openclaw.json",
		pathPattern: "models.providers.*.request.headers.*",
		secretShape: SECRET_INPUT_SHAPE,
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true,
		providerIdPathSegmentIndex: 2
	},
	{
		id: "models.providers.*.request.auth.token",
		targetType: "models.providers.request.auth.token",
		targetTypeAliases: ["models.providers.*.request.auth.token"],
		configFile: "openclaw.json",
		pathPattern: "models.providers.*.request.auth.token",
		secretShape: SECRET_INPUT_SHAPE,
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true,
		providerIdPathSegmentIndex: 2
	},
	{
		id: "models.providers.*.request.auth.value",
		targetType: "models.providers.request.auth.value",
		targetTypeAliases: ["models.providers.*.request.auth.value"],
		configFile: "openclaw.json",
		pathPattern: "models.providers.*.request.auth.value",
		secretShape: SECRET_INPUT_SHAPE,
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true,
		providerIdPathSegmentIndex: 2
	},
	{
		id: "models.providers.*.request.proxy.tls.ca",
		targetType: "models.providers.request.proxy.tls.ca",
		targetTypeAliases: ["models.providers.*.request.proxy.tls.ca"],
		configFile: "openclaw.json",
		pathPattern: "models.providers.*.request.proxy.tls.ca",
		secretShape: SECRET_INPUT_SHAPE,
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true,
		providerIdPathSegmentIndex: 2
	},
	{
		id: "models.providers.*.request.proxy.tls.cert",
		targetType: "models.providers.request.proxy.tls.cert",
		targetTypeAliases: ["models.providers.*.request.proxy.tls.cert"],
		configFile: "openclaw.json",
		pathPattern: "models.providers.*.request.proxy.tls.cert",
		secretShape: SECRET_INPUT_SHAPE,
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true,
		providerIdPathSegmentIndex: 2
	},
	{
		id: "models.providers.*.request.proxy.tls.key",
		targetType: "models.providers.request.proxy.tls.key",
		targetTypeAliases: ["models.providers.*.request.proxy.tls.key"],
		configFile: "openclaw.json",
		pathPattern: "models.providers.*.request.proxy.tls.key",
		secretShape: SECRET_INPUT_SHAPE,
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true,
		providerIdPathSegmentIndex: 2
	},
	{
		id: "models.providers.*.request.proxy.tls.passphrase",
		targetType: "models.providers.request.proxy.tls.passphrase",
		targetTypeAliases: ["models.providers.*.request.proxy.tls.passphrase"],
		configFile: "openclaw.json",
		pathPattern: "models.providers.*.request.proxy.tls.passphrase",
		secretShape: SECRET_INPUT_SHAPE,
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true,
		providerIdPathSegmentIndex: 2
	},
	{
		id: "models.providers.*.request.tls.ca",
		targetType: "models.providers.request.tls.ca",
		targetTypeAliases: ["models.providers.*.request.tls.ca"],
		configFile: "openclaw.json",
		pathPattern: "models.providers.*.request.tls.ca",
		secretShape: SECRET_INPUT_SHAPE,
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true,
		providerIdPathSegmentIndex: 2
	},
	{
		id: "models.providers.*.request.tls.cert",
		targetType: "models.providers.request.tls.cert",
		targetTypeAliases: ["models.providers.*.request.tls.cert"],
		configFile: "openclaw.json",
		pathPattern: "models.providers.*.request.tls.cert",
		secretShape: SECRET_INPUT_SHAPE,
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true,
		providerIdPathSegmentIndex: 2
	},
	{
		id: "models.providers.*.request.tls.key",
		targetType: "models.providers.request.tls.key",
		targetTypeAliases: ["models.providers.*.request.tls.key"],
		configFile: "openclaw.json",
		pathPattern: "models.providers.*.request.tls.key",
		secretShape: SECRET_INPUT_SHAPE,
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true,
		providerIdPathSegmentIndex: 2
	},
	{
		id: "models.providers.*.request.tls.passphrase",
		targetType: "models.providers.request.tls.passphrase",
		targetTypeAliases: ["models.providers.*.request.tls.passphrase"],
		configFile: "openclaw.json",
		pathPattern: "models.providers.*.request.tls.passphrase",
		secretShape: SECRET_INPUT_SHAPE,
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true,
		providerIdPathSegmentIndex: 2
	},
	{
		id: "skills.entries.*.apiKey",
		targetType: "skills.entries.apiKey",
		targetTypeAliases: ["skills.entries.*.apiKey"],
		configFile: "openclaw.json",
		pathPattern: "skills.entries.*.apiKey",
		secretShape: SECRET_INPUT_SHAPE,
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "talk.providers.*.apiKey",
		targetType: "talk.providers.*.apiKey",
		configFile: "openclaw.json",
		pathPattern: "talk.providers.*.apiKey",
		secretShape: SECRET_INPUT_SHAPE,
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true,
		providerIdPathSegmentIndex: 2
	},
	{
		id: "tools.web.search.apiKey",
		targetType: "tools.web.search.apiKey",
		configFile: "openclaw.json",
		pathPattern: "tools.web.search.apiKey",
		secretShape: SECRET_INPUT_SHAPE,
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "tools.web.fetch.firecrawl.apiKey",
		targetType: "tools.web.fetch.firecrawl.apiKey",
		configFile: "openclaw.json",
		pathPattern: "tools.web.fetch.firecrawl.apiKey",
		secretShape: SECRET_INPUT_SHAPE,
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "tools.web.search.*.apiKey",
		targetType: "tools.web.search.*.apiKey",
		configFile: "openclaw.json",
		pathPattern: "tools.web.search.*.apiKey",
		secretShape: SECRET_INPUT_SHAPE,
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: false,
		includeInAudit: true,
		providerIdPathSegmentIndex: 3
	}
];
let cachedSecretTargetRegistry = null;
function loadSecretTargetRegistryFromPluginMetadata(params) {
	const plugins = (params.preferPersisted === false ? void 0 : getCurrentPluginMetadataSnapshot({
		config: {},
		env: params.env
	}))?.plugins ?? loadPluginMetadataSnapshot({
		config: {},
		env: params.env,
		...params.preferPersisted !== void 0 ? { preferPersisted: params.preferPersisted } : {}
	}).plugins;
	const bundledPlugins = plugins.filter((record) => record.origin === "bundled");
	const channelPlugins = plugins.filter((record) => record.channels.length > 0);
	return [
		...CORE_SECRET_TARGET_REGISTRY,
		...listBundledWebProviderSecretTargetRegistryEntries(bundledPlugins),
		...listBundledPluginConfigSecretTargetRegistryEntries(bundledPlugins),
		...listChannelSecretTargetRegistryEntries(channelPlugins)
	];
}
function getCoreSecretTargetRegistry() {
	return CORE_SECRET_TARGET_REGISTRY;
}
function getSecretTargetRegistry() {
	if (cachedSecretTargetRegistry) return cachedSecretTargetRegistry;
	cachedSecretTargetRegistry = loadSecretTargetRegistryFromPluginMetadata({ env: process.env });
	return cachedSecretTargetRegistry;
}
//#endregion
//#region src/secrets/target-registry-pattern.ts
function countDynamicPatternTokens(tokens) {
	return tokens.filter((token) => token.kind === "wildcard" || token.kind === "array").length;
}
function parsePathPattern(pathPattern) {
	return parseDotPath(pathPattern).map((segment) => {
		if (segment === "*") return { kind: "wildcard" };
		if (segment.endsWith("[]")) {
			const field = segment.slice(0, -2).trim();
			if (!field) throw new Error(`Invalid target path pattern: ${pathPattern}`);
			return {
				kind: "array",
				field
			};
		}
		return {
			kind: "literal",
			value: segment
		};
	});
}
function compileTargetRegistryEntry(entry) {
	const pathTokens = parsePathPattern(entry.pathPattern);
	const pathDynamicTokenCount = countDynamicPatternTokens(pathTokens);
	const refPathTokens = entry.refPathPattern ? parsePathPattern(entry.refPathPattern) : void 0;
	const refPathDynamicTokenCount = refPathTokens ? countDynamicPatternTokens(refPathTokens) : 0;
	if (entry.secretShape === "sibling_ref" && !refPathTokens) throw new Error(`Missing refPathPattern for sibling_ref target: ${entry.id}`);
	if (refPathTokens && refPathDynamicTokenCount !== pathDynamicTokenCount) throw new Error(`Mismatched wildcard shape for target ref path: ${entry.id}`);
	return {
		...entry,
		pathTokens,
		pathDynamicTokenCount,
		refPathTokens,
		refPathDynamicTokenCount
	};
}
function matchPathTokens(segments, tokens) {
	const captures = [];
	let index = 0;
	for (const token of tokens) {
		if (token.kind === "literal") {
			if (segments[index] !== token.value) return null;
			index += 1;
			continue;
		}
		if (token.kind === "wildcard") {
			const value = segments[index];
			if (!value) return null;
			captures.push(value);
			index += 1;
			continue;
		}
		if (segments[index] !== token.field) return null;
		const next = segments[index + 1];
		if (!next || !/^\d+$/.test(next)) return null;
		captures.push(next);
		index += 2;
	}
	return index === segments.length ? { captures } : null;
}
function materializePathTokens(tokens, captures) {
	const out = [];
	let captureIndex = 0;
	for (const token of tokens) {
		if (token.kind === "literal") {
			out.push(token.value);
			continue;
		}
		if (token.kind === "wildcard") {
			const value = captures[captureIndex];
			if (!value) return null;
			out.push(value);
			captureIndex += 1;
			continue;
		}
		const arrayIndex = captures[captureIndex];
		if (!arrayIndex || !/^\d+$/.test(arrayIndex)) return null;
		out.push(token.field, arrayIndex);
		captureIndex += 1;
	}
	return captureIndex === captures.length ? out : null;
}
function expandPathTokens(root, tokens) {
	const out = [];
	const walk = (node, tokenIndex, segments, captures) => {
		const token = tokens[tokenIndex];
		if (!token) {
			out.push({
				segments,
				captures,
				value: node
			});
			return;
		}
		const isLeaf = tokenIndex === tokens.length - 1;
		if (token.kind === "literal") {
			if (!isRecord(node)) return;
			if (isLeaf) {
				out.push({
					segments: [...segments, token.value],
					captures,
					value: node[token.value]
				});
				return;
			}
			if (!Object.prototype.hasOwnProperty.call(node, token.value)) return;
			walk(node[token.value], tokenIndex + 1, [...segments, token.value], captures);
			return;
		}
		if (token.kind === "wildcard") {
			if (!isRecord(node)) return;
			for (const [key, value] of Object.entries(node)) {
				if (isLeaf) {
					out.push({
						segments: [...segments, key],
						captures: [...captures, key],
						value
					});
					continue;
				}
				walk(value, tokenIndex + 1, [...segments, key], [...captures, key]);
			}
			return;
		}
		if (!isRecord(node)) return;
		const items = node[token.field];
		if (!Array.isArray(items)) return;
		for (let index = 0; index < items.length; index += 1) {
			const item = items[index];
			const indexString = String(index);
			if (isLeaf) {
				out.push({
					segments: [
						...segments,
						token.field,
						indexString
					],
					captures: [...captures, indexString],
					value: item
				});
				continue;
			}
			walk(item, tokenIndex + 1, [
				...segments,
				token.field,
				indexString
			], [...captures, indexString]);
		}
	};
	walk(root, 0, [], []);
	return out;
}
//#endregion
//#region src/secrets/target-registry-query.ts
let compiledSecretTargetRegistryState = null;
let compiledCoreOpenClawTargetState = null;
const compiledChannelOpenClawTargets = /* @__PURE__ */ new Map();
function buildTargetTypeIndex(compiledSecretTargetRegistry) {
	const byType = /* @__PURE__ */ new Map();
	const append = (type, entry) => {
		const existing = byType.get(type);
		if (existing) {
			existing.push(entry);
			return;
		}
		byType.set(type, [entry]);
	};
	for (const entry of compiledSecretTargetRegistry) {
		append(entry.targetType, entry);
		for (const alias of entry.targetTypeAliases ?? []) append(alias, entry);
	}
	return byType;
}
function buildConfigTargetIdIndex(entries) {
	const byId = /* @__PURE__ */ new Map();
	for (const entry of entries) {
		const existing = byId.get(entry.id);
		if (existing) {
			existing.push(entry);
			continue;
		}
		byId.set(entry.id, [entry]);
	}
	return byId;
}
function getCompiledSecretTargetRegistryState() {
	if (compiledSecretTargetRegistryState) return compiledSecretTargetRegistryState;
	const compiledSecretTargetRegistry = getSecretTargetRegistry().map(compileTargetRegistryEntry);
	const openClawCompiledSecretTargets = compiledSecretTargetRegistry.filter((entry) => entry.configFile === "openclaw.json");
	const authProfilesCompiledSecretTargets = compiledSecretTargetRegistry.filter((entry) => entry.configFile === "auth-profiles.json");
	compiledSecretTargetRegistryState = {
		authProfilesCompiledSecretTargets,
		authProfilesTargetsById: buildConfigTargetIdIndex(authProfilesCompiledSecretTargets),
		compiledSecretTargetRegistry,
		knownTargetIds: new Set(compiledSecretTargetRegistry.map((entry) => entry.id)),
		openClawCompiledSecretTargets,
		openClawTargetsById: buildConfigTargetIdIndex(openClawCompiledSecretTargets),
		targetsByType: buildTargetTypeIndex(compiledSecretTargetRegistry)
	};
	return compiledSecretTargetRegistryState;
}
function getCompiledCoreOpenClawTargetState() {
	if (compiledCoreOpenClawTargetState) return compiledCoreOpenClawTargetState;
	const openClawCompiledSecretTargets = getCoreSecretTargetRegistry().filter((entry) => entry.configFile === "openclaw.json").map(compileTargetRegistryEntry);
	compiledCoreOpenClawTargetState = {
		knownTargetIds: new Set(openClawCompiledSecretTargets.map((entry) => entry.id)),
		openClawCompiledSecretTargets,
		openClawTargetsById: buildConfigTargetIdIndex(openClawCompiledSecretTargets),
		targetsByType: buildTargetTypeIndex(openClawCompiledSecretTargets)
	};
	return compiledCoreOpenClawTargetState;
}
function getCompiledChannelOpenClawTargets(channelId) {
	const normalizedChannelId = channelId.trim();
	if (!normalizedChannelId) return null;
	if (compiledChannelOpenClawTargets.has(normalizedChannelId)) return compiledChannelOpenClawTargets.get(normalizedChannelId) ?? null;
	const compiledEntries = loadChannelSecretContractApi({
		channelId: normalizedChannelId,
		config: {},
		env: process.env
	})?.secretTargetRegistryEntries?.filter((entry) => entry.configFile === "openclaw.json").map(compileTargetRegistryEntry) ?? null;
	compiledChannelOpenClawTargets.set(normalizedChannelId, compiledEntries);
	return compiledEntries;
}
function normalizeAllowedTargetIds(targetIds) {
	if (targetIds === void 0) return null;
	return new Set(Array.from(targetIds).map((entry) => entry.trim()).filter((entry) => entry.length > 0));
}
function resolveDiscoveryEntries(params) {
	if (params.allowedTargetIds === null) return params.defaultEntries;
	return Array.from(params.allowedTargetIds).flatMap((targetId) => params.entriesById.get(targetId) ?? []);
}
function discoverSecretTargetsFromEntries(source, discoveryEntries) {
	const out = [];
	const seen = /* @__PURE__ */ new Set();
	for (const entry of discoveryEntries) {
		const expanded = expandPathTokens(source, entry.pathTokens);
		for (const match of expanded) {
			const resolved = toResolvedPlanTarget(entry, match.segments, match.captures);
			if (!resolved) continue;
			const key = `${entry.id}:${resolved.pathSegments.join(".")}`;
			if (seen.has(key)) continue;
			seen.add(key);
			const refValue = resolved.refPathSegments ? getPath(source, resolved.refPathSegments) : void 0;
			out.push({
				entry,
				path: resolved.pathSegments.join("."),
				pathSegments: resolved.pathSegments,
				...resolved.refPathSegments ? {
					refPathSegments: resolved.refPathSegments,
					refPath: resolved.refPathSegments.join(".")
				} : {},
				value: match.value,
				...resolved.providerId ? { providerId: resolved.providerId } : {},
				...resolved.accountId ? { accountId: resolved.accountId } : {},
				...resolved.refPathSegments ? { refValue } : {}
			});
		}
	}
	return out;
}
function toResolvedPlanTarget(entry, pathSegments, captures) {
	const providerId = entry.providerIdPathSegmentIndex !== void 0 ? pathSegments[entry.providerIdPathSegmentIndex] : void 0;
	const accountId = entry.accountIdPathSegmentIndex !== void 0 ? pathSegments[entry.accountIdPathSegmentIndex] : void 0;
	const refPathSegments = entry.refPathTokens ? materializePathTokens(entry.refPathTokens, captures) : void 0;
	if (entry.refPathTokens && !refPathSegments) return null;
	return {
		entry,
		pathSegments,
		...refPathSegments ? { refPathSegments } : {},
		...providerId ? { providerId } : {},
		...accountId ? { accountId } : {}
	};
}
function listSecretTargetRegistryEntries() {
	return getCompiledSecretTargetRegistryState().compiledSecretTargetRegistry.map((entry) => Object.assign({
		id: entry.id,
		targetType: entry.targetType
	}, entry.targetTypeAliases ? { targetTypeAliases: [...entry.targetTypeAliases] } : {}, {
		configFile: entry.configFile,
		pathPattern: entry.pathPattern
	}, entry.refPathPattern ? { refPathPattern: entry.refPathPattern } : {}, {
		secretShape: entry.secretShape,
		expectedResolvedValue: entry.expectedResolvedValue,
		includeInPlan: entry.includeInPlan,
		includeInConfigure: entry.includeInConfigure,
		includeInAudit: entry.includeInAudit
	}, entry.providerIdPathSegmentIndex !== void 0 ? { providerIdPathSegmentIndex: entry.providerIdPathSegmentIndex } : {}, entry.accountIdPathSegmentIndex !== void 0 ? { accountIdPathSegmentIndex: entry.accountIdPathSegmentIndex } : {}, entry.authProfileType ? { authProfileType: entry.authProfileType } : {}, entry.trackProviderShadowing ? { trackProviderShadowing: true } : {}));
}
function isKnownSecretTargetId(value) {
	return typeof value === "string" && getCompiledSecretTargetRegistryState().knownTargetIds.has(value);
}
function resolvePlanTargetAgainstRegistry(candidate) {
	const coreEntries = getCompiledCoreOpenClawTargetState().targetsByType.get(candidate.type);
	if (coreEntries) return resolvePlanTargetAgainstEntries(candidate, coreEntries);
	return resolvePlanTargetAgainstEntries(candidate, getCompiledSecretTargetRegistryState().targetsByType.get(candidate.type));
}
function resolvePlanTargetAgainstEntries(candidate, entries) {
	if (!entries || entries.length === 0) return null;
	for (const entry of entries) {
		if (!entry.includeInPlan) continue;
		const matched = matchPathTokens(candidate.pathSegments, entry.pathTokens);
		if (!matched) continue;
		const resolved = toResolvedPlanTarget(entry, candidate.pathSegments, matched.captures);
		if (!resolved) continue;
		if (candidate.providerId && candidate.providerId.trim().length > 0) {
			if (!resolved.providerId || resolved.providerId !== candidate.providerId) continue;
		}
		if (candidate.accountId && candidate.accountId.trim().length > 0) {
			if (!resolved.accountId || resolved.accountId !== candidate.accountId) continue;
		}
		return resolved;
	}
	return null;
}
function resolveConfigSecretTargetByPath(pathSegments) {
	for (const entry of getCompiledCoreOpenClawTargetState().openClawCompiledSecretTargets) {
		if (!entry.includeInPlan) continue;
		const matched = matchPathTokens(pathSegments, entry.pathTokens);
		if (!matched) continue;
		const resolved = toResolvedPlanTarget(entry, pathSegments, matched.captures);
		if (!resolved) continue;
		return resolved;
	}
	const explicitChannelId = pathSegments[0] === "channels" ? pathSegments[1]?.trim() ?? "" : "";
	const explicitChannelEntries = explicitChannelId ? getCompiledChannelOpenClawTargets(explicitChannelId) : null;
	for (const entry of explicitChannelEntries ?? []) {
		if (!entry.includeInPlan) continue;
		const matched = matchPathTokens(pathSegments, entry.pathTokens);
		if (!matched) continue;
		const resolved = toResolvedPlanTarget(entry, pathSegments, matched.captures);
		if (!resolved) continue;
		return resolved;
	}
	for (const entry of getCompiledSecretTargetRegistryState().openClawCompiledSecretTargets) {
		if (!entry.includeInPlan) continue;
		const matched = matchPathTokens(pathSegments, entry.pathTokens);
		if (!matched) continue;
		const resolved = toResolvedPlanTarget(entry, pathSegments, matched.captures);
		if (!resolved) continue;
		return resolved;
	}
	return null;
}
function discoverConfigSecretTargets(config) {
	return discoverConfigSecretTargetsByIds(config);
}
function discoverConfigSecretTargetsByIds(config, targetIds) {
	const allowedTargetIds = normalizeAllowedTargetIds(targetIds);
	const registryState = allowedTargetIds !== null && Array.from(allowedTargetIds).every((targetId) => getCompiledCoreOpenClawTargetState().knownTargetIds.has(targetId)) ? getCompiledCoreOpenClawTargetState() : getCompiledSecretTargetRegistryState();
	return discoverSecretTargetsFromEntries(config, resolveDiscoveryEntries({
		allowedTargetIds,
		defaultEntries: registryState.openClawCompiledSecretTargets,
		entriesById: registryState.openClawTargetsById
	}));
}
function discoverAuthProfileSecretTargets(store, targetIds) {
	const allowedTargetIds = normalizeAllowedTargetIds(targetIds);
	const registryState = getCompiledSecretTargetRegistryState();
	return discoverSecretTargetsFromEntries(store, resolveDiscoveryEntries({
		allowedTargetIds,
		defaultEntries: registryState.authProfilesCompiledSecretTargets,
		entriesById: registryState.authProfilesTargetsById
	}));
}
function listAuthProfileSecretTargetEntries() {
	return getCompiledSecretTargetRegistryState().compiledSecretTargetRegistry.filter((entry) => entry.configFile === "auth-profiles.json" && entry.includeInAudit);
}
//#endregion
export { listAuthProfileSecretTargetEntries as a, resolvePlanTargetAgainstRegistry as c, isKnownSecretTargetId as i, discoverConfigSecretTargets as n, listSecretTargetRegistryEntries as o, discoverConfigSecretTargetsByIds as r, resolveConfigSecretTargetByPath as s, discoverAuthProfileSecretTargets as t };
