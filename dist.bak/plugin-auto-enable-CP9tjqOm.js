import { $ as isRecord, D as getChatChannelMeta, O as listChatChannels, W as CONFIG_DIR, j as normalizeChatChannelId, st as resolveUserPath } from "./entry.js";
import { Vn as normalizeProviderId } from "./auth-profiles-D6H-HVV8.js";
import { n as loadPluginManifestRegistry, r as discoverOpenClawPlugins } from "./manifest-registry-HLdbjiS7.js";
import { n as MANIFEST_KEY } from "./legacy-names-DNgFuAUV.js";
import { t as hasAnyWhatsAppAuth } from "./accounts-jTTYYc3C.js";
import path from "node:path";
import fs from "node:fs";

//#region src/channels/plugins/catalog.ts
const ORIGIN_PRIORITY = {
	config: 0,
	workspace: 1,
	global: 2,
	bundled: 3
};
const DEFAULT_CATALOG_PATHS = [
	path.join(CONFIG_DIR, "mpm", "plugins.json"),
	path.join(CONFIG_DIR, "mpm", "catalog.json"),
	path.join(CONFIG_DIR, "plugins", "catalog.json")
];
const ENV_CATALOG_PATHS = ["OPENCLAW_PLUGIN_CATALOG_PATHS", "OPENCLAW_MPM_CATALOG_PATHS"];
function parseCatalogEntries(raw) {
	if (Array.isArray(raw)) return raw.filter((entry) => isRecord(entry));
	if (!isRecord(raw)) return [];
	const list = raw.entries ?? raw.packages ?? raw.plugins;
	if (!Array.isArray(list)) return [];
	return list.filter((entry) => isRecord(entry));
}
function splitEnvPaths(value) {
	const trimmed = value.trim();
	if (!trimmed) return [];
	return trimmed.split(/[;,]/g).flatMap((chunk) => chunk.split(path.delimiter)).map((entry) => entry.trim()).filter(Boolean);
}
function resolveExternalCatalogPaths(options) {
	if (options.catalogPaths && options.catalogPaths.length > 0) return options.catalogPaths.map((entry) => entry.trim()).filter(Boolean);
	for (const key of ENV_CATALOG_PATHS) {
		const raw = process.env[key];
		if (raw && raw.trim()) return splitEnvPaths(raw);
	}
	return DEFAULT_CATALOG_PATHS;
}
function loadExternalCatalogEntries(options) {
	const paths = resolveExternalCatalogPaths(options);
	const entries = [];
	for (const rawPath of paths) {
		const resolved = resolveUserPath(rawPath);
		if (!fs.existsSync(resolved)) continue;
		try {
			const payload = JSON.parse(fs.readFileSync(resolved, "utf-8"));
			entries.push(...parseCatalogEntries(payload));
		} catch {}
	}
	return entries;
}
function toChannelMeta(params) {
	const label = params.channel.label?.trim();
	if (!label) return null;
	const selectionLabel = params.channel.selectionLabel?.trim() || label;
	const detailLabel = params.channel.detailLabel?.trim();
	const docsPath = params.channel.docsPath?.trim() || `/channels/${params.id}`;
	const blurb = params.channel.blurb?.trim() || "";
	const systemImage = params.channel.systemImage?.trim();
	return {
		id: params.id,
		label,
		selectionLabel,
		...detailLabel ? { detailLabel } : {},
		docsPath,
		docsLabel: params.channel.docsLabel?.trim() || void 0,
		blurb,
		...params.channel.aliases ? { aliases: params.channel.aliases } : {},
		...params.channel.preferOver ? { preferOver: params.channel.preferOver } : {},
		...params.channel.order !== void 0 ? { order: params.channel.order } : {},
		...params.channel.selectionDocsPrefix ? { selectionDocsPrefix: params.channel.selectionDocsPrefix } : {},
		...params.channel.selectionDocsOmitLabel !== void 0 ? { selectionDocsOmitLabel: params.channel.selectionDocsOmitLabel } : {},
		...params.channel.selectionExtras ? { selectionExtras: params.channel.selectionExtras } : {},
		...systemImage ? { systemImage } : {},
		...params.channel.showConfigured !== void 0 ? { showConfigured: params.channel.showConfigured } : {},
		...params.channel.quickstartAllowFrom !== void 0 ? { quickstartAllowFrom: params.channel.quickstartAllowFrom } : {},
		...params.channel.forceAccountBinding !== void 0 ? { forceAccountBinding: params.channel.forceAccountBinding } : {},
		...params.channel.preferSessionLookupForAnnounceTarget !== void 0 ? { preferSessionLookupForAnnounceTarget: params.channel.preferSessionLookupForAnnounceTarget } : {}
	};
}
function resolveInstallInfo(params) {
	const npmSpec = params.manifest.install?.npmSpec?.trim() ?? params.packageName?.trim();
	if (!npmSpec) return null;
	let localPath = params.manifest.install?.localPath?.trim() || void 0;
	if (!localPath && params.workspaceDir && params.packageDir) localPath = path.relative(params.workspaceDir, params.packageDir) || void 0;
	const defaultChoice = params.manifest.install?.defaultChoice ?? (localPath ? "local" : "npm");
	return {
		npmSpec,
		...localPath ? { localPath } : {},
		...defaultChoice ? { defaultChoice } : {}
	};
}
function buildCatalogEntry(candidate) {
	const manifest = candidate.packageManifest;
	if (!manifest?.channel) return null;
	const id = manifest.channel.id?.trim();
	if (!id) return null;
	const meta = toChannelMeta({
		channel: manifest.channel,
		id
	});
	if (!meta) return null;
	const install = resolveInstallInfo({
		manifest,
		packageName: candidate.packageName,
		packageDir: candidate.packageDir,
		workspaceDir: candidate.workspaceDir
	});
	if (!install) return null;
	return {
		id,
		meta,
		install
	};
}
function buildExternalCatalogEntry(entry) {
	const manifest = entry[MANIFEST_KEY];
	return buildCatalogEntry({
		packageName: entry.name,
		packageManifest: manifest
	});
}
function buildChannelUiCatalog(plugins) {
	const entries = plugins.map((plugin) => {
		const detailLabel = plugin.meta.detailLabel ?? plugin.meta.selectionLabel ?? plugin.meta.label;
		return {
			id: plugin.id,
			label: plugin.meta.label,
			detailLabel,
			...plugin.meta.systemImage ? { systemImage: plugin.meta.systemImage } : {}
		};
	});
	const order = entries.map((entry) => entry.id);
	const labels = {};
	const detailLabels = {};
	const systemImages = {};
	const byId = {};
	for (const entry of entries) {
		labels[entry.id] = entry.label;
		detailLabels[entry.id] = entry.detailLabel;
		if (entry.systemImage) systemImages[entry.id] = entry.systemImage;
		byId[entry.id] = entry;
	}
	return {
		entries,
		order,
		labels,
		detailLabels,
		systemImages,
		byId
	};
}
function listChannelPluginCatalogEntries(options = {}) {
	const discovery = discoverOpenClawPlugins({ workspaceDir: options.workspaceDir });
	const resolved = /* @__PURE__ */ new Map();
	for (const candidate of discovery.candidates) {
		const entry = buildCatalogEntry(candidate);
		if (!entry) continue;
		const priority = ORIGIN_PRIORITY[candidate.origin] ?? 99;
		const existing = resolved.get(entry.id);
		if (!existing || priority < existing.priority) resolved.set(entry.id, {
			entry,
			priority
		});
	}
	const externalEntries = loadExternalCatalogEntries(options).map((entry) => buildExternalCatalogEntry(entry)).filter((entry) => Boolean(entry));
	for (const entry of externalEntries) if (!resolved.has(entry.id)) resolved.set(entry.id, {
		entry,
		priority: 99
	});
	return Array.from(resolved.values()).map(({ entry }) => entry).toSorted((a, b) => {
		const orderA = a.meta.order ?? 999;
		const orderB = b.meta.order ?? 999;
		if (orderA !== orderB) return orderA - orderB;
		return a.meta.label.localeCompare(b.meta.label);
	});
}
function getChannelPluginCatalogEntry(id, options = {}) {
	const trimmed = id.trim();
	if (!trimmed) return;
	return listChannelPluginCatalogEntries(options).find((entry) => entry.id === trimmed);
}

//#endregion
//#region src/config/plugins-allowlist.ts
function ensurePluginAllowlisted(cfg, pluginId) {
	const allow = cfg.plugins?.allow;
	if (!Array.isArray(allow) || allow.includes(pluginId)) return cfg;
	return {
		...cfg,
		plugins: {
			...cfg.plugins,
			allow: [...allow, pluginId]
		}
	};
}

//#endregion
//#region src/config/plugin-auto-enable.ts
const CHANNEL_PLUGIN_IDS = Array.from(new Set([...listChatChannels().map((meta) => meta.id), ...listChannelPluginCatalogEntries().map((entry) => entry.id)]));
const PROVIDER_PLUGIN_IDS = [
	{
		pluginId: "google-gemini-cli-auth",
		providerId: "google-gemini-cli"
	},
	{
		pluginId: "qwen-portal-auth",
		providerId: "qwen-portal"
	},
	{
		pluginId: "copilot-proxy",
		providerId: "copilot-proxy"
	},
	{
		pluginId: "minimax-portal-auth",
		providerId: "minimax-portal"
	}
];
function hasNonEmptyString(value) {
	return typeof value === "string" && value.trim().length > 0;
}
function recordHasKeys(value) {
	return isRecord(value) && Object.keys(value).length > 0;
}
function accountsHaveKeys(value, keys) {
	if (!isRecord(value)) return false;
	for (const account of Object.values(value)) {
		if (!isRecord(account)) continue;
		for (const key of keys) if (hasNonEmptyString(account[key])) return true;
	}
	return false;
}
function resolveChannelConfig(cfg, channelId) {
	const entry = cfg.channels?.[channelId];
	return isRecord(entry) ? entry : null;
}
const STRUCTURED_CHANNEL_CONFIG_SPECS = {
	telegram: {
		envAny: ["TELEGRAM_BOT_TOKEN"],
		stringKeys: ["botToken", "tokenFile"],
		accountStringKeys: ["botToken", "tokenFile"]
	},
	discord: {
		envAny: ["DISCORD_BOT_TOKEN"],
		stringKeys: ["token"],
		accountStringKeys: ["token"]
	},
	irc: {
		envAll: ["IRC_HOST", "IRC_NICK"],
		stringKeys: ["host", "nick"],
		accountStringKeys: ["host", "nick"]
	},
	slack: {
		envAny: [
			"SLACK_BOT_TOKEN",
			"SLACK_APP_TOKEN",
			"SLACK_USER_TOKEN"
		],
		stringKeys: [
			"botToken",
			"appToken",
			"userToken"
		],
		accountStringKeys: [
			"botToken",
			"appToken",
			"userToken"
		]
	},
	signal: {
		stringKeys: [
			"account",
			"httpUrl",
			"httpHost",
			"cliPath"
		],
		numberKeys: ["httpPort"],
		accountStringKeys: [
			"account",
			"httpUrl",
			"httpHost",
			"cliPath"
		]
	},
	imessage: { stringKeys: ["cliPath"] }
};
function envHasAnyKeys(env, keys) {
	for (const key of keys) if (hasNonEmptyString(env[key])) return true;
	return false;
}
function envHasAllKeys(env, keys) {
	for (const key of keys) if (!hasNonEmptyString(env[key])) return false;
	return keys.length > 0;
}
function hasAnyNumberKeys(entry, keys) {
	for (const key of keys) if (typeof entry[key] === "number") return true;
	return false;
}
function isStructuredChannelConfigured(cfg, channelId, env, spec) {
	if (spec.envAny && envHasAnyKeys(env, spec.envAny)) return true;
	if (spec.envAll && envHasAllKeys(env, spec.envAll)) return true;
	const entry = resolveChannelConfig(cfg, channelId);
	if (!entry) return false;
	if (spec.stringKeys && spec.stringKeys.some((key) => hasNonEmptyString(entry[key]))) return true;
	if (spec.numberKeys && hasAnyNumberKeys(entry, spec.numberKeys)) return true;
	if (spec.accountStringKeys && accountsHaveKeys(entry.accounts, spec.accountStringKeys)) return true;
	return recordHasKeys(entry);
}
function isWhatsAppConfigured(cfg) {
	if (hasAnyWhatsAppAuth(cfg)) return true;
	const entry = resolveChannelConfig(cfg, "whatsapp");
	if (!entry) return false;
	return recordHasKeys(entry);
}
function isGenericChannelConfigured(cfg, channelId) {
	return recordHasKeys(resolveChannelConfig(cfg, channelId));
}
function isChannelConfigured(cfg, channelId, env = process.env) {
	if (channelId === "whatsapp") return isWhatsAppConfigured(cfg);
	const spec = STRUCTURED_CHANNEL_CONFIG_SPECS[channelId];
	if (spec) return isStructuredChannelConfigured(cfg, channelId, env, spec);
	return isGenericChannelConfigured(cfg, channelId);
}
function collectModelRefs(cfg) {
	const refs = [];
	const pushModelRef = (value) => {
		if (typeof value === "string" && value.trim()) refs.push(value.trim());
	};
	const collectFromAgent = (agent) => {
		if (!agent) return;
		const model = agent.model;
		if (typeof model === "string") pushModelRef(model);
		else if (isRecord(model)) {
			pushModelRef(model.primary);
			const fallbacks = model.fallbacks;
			if (Array.isArray(fallbacks)) for (const entry of fallbacks) pushModelRef(entry);
		}
		const models = agent.models;
		if (isRecord(models)) for (const key of Object.keys(models)) pushModelRef(key);
	};
	const defaults = cfg.agents?.defaults;
	collectFromAgent(defaults);
	const list = cfg.agents?.list;
	if (Array.isArray(list)) {
		for (const entry of list) if (isRecord(entry)) collectFromAgent(entry);
	}
	return refs;
}
function extractProviderFromModelRef(value) {
	const trimmed = value.trim();
	const slash = trimmed.indexOf("/");
	if (slash <= 0) return null;
	return normalizeProviderId(trimmed.slice(0, slash));
}
function isProviderConfigured(cfg, providerId) {
	const normalized = normalizeProviderId(providerId);
	const profiles = cfg.auth?.profiles;
	if (profiles && typeof profiles === "object") for (const profile of Object.values(profiles)) {
		if (!isRecord(profile)) continue;
		if (normalizeProviderId(String(profile.provider ?? "")) === normalized) return true;
	}
	const providerConfig = cfg.models?.providers;
	if (providerConfig && typeof providerConfig === "object") {
		for (const key of Object.keys(providerConfig)) if (normalizeProviderId(key) === normalized) return true;
	}
	const modelRefs = collectModelRefs(cfg);
	for (const ref of modelRefs) {
		const provider = extractProviderFromModelRef(ref);
		if (provider && provider === normalized) return true;
	}
	return false;
}
function buildChannelToPluginIdMap(registry) {
	const map = /* @__PURE__ */ new Map();
	for (const record of registry.plugins) for (const channelId of record.channels) if (channelId && !map.has(channelId)) map.set(channelId, record.id);
	return map;
}
function resolvePluginIdForChannel(channelId, channelToPluginId) {
	const builtInId = normalizeChatChannelId(channelId);
	if (builtInId) return builtInId;
	return channelToPluginId.get(channelId) ?? channelId;
}
function collectCandidateChannelIds(cfg) {
	const channelIds = new Set(CHANNEL_PLUGIN_IDS);
	const configuredChannels = cfg.channels;
	if (!configuredChannels || typeof configuredChannels !== "object") return Array.from(channelIds);
	for (const key of Object.keys(configuredChannels)) {
		if (key === "defaults" || key === "modelByChannel") continue;
		const normalizedBuiltIn = normalizeChatChannelId(key);
		channelIds.add(normalizedBuiltIn ?? key);
	}
	return Array.from(channelIds);
}
function resolveConfiguredPlugins(cfg, env, registry) {
	const changes = [];
	const channelToPluginId = buildChannelToPluginIdMap(registry);
	for (const channelId of collectCandidateChannelIds(cfg)) {
		const pluginId = resolvePluginIdForChannel(channelId, channelToPluginId);
		if (isChannelConfigured(cfg, channelId, env)) changes.push({
			pluginId,
			reason: `${channelId} configured`
		});
	}
	for (const mapping of PROVIDER_PLUGIN_IDS) if (isProviderConfigured(cfg, mapping.providerId)) changes.push({
		pluginId: mapping.pluginId,
		reason: `${mapping.providerId} auth configured`
	});
	const backendRaw = typeof cfg.acp?.backend === "string" ? cfg.acp.backend.trim().toLowerCase() : "";
	if ((cfg.acp?.enabled === true || cfg.acp?.dispatch?.enabled === true || backendRaw === "acpx") && (!backendRaw || backendRaw === "acpx")) changes.push({
		pluginId: "acpx",
		reason: "ACP runtime configured"
	});
	return changes;
}
function isPluginExplicitlyDisabled(cfg, pluginId) {
	const builtInChannelId = normalizeChatChannelId(pluginId);
	if (builtInChannelId) {
		const channelConfig = cfg.channels?.[builtInChannelId];
		if (channelConfig && typeof channelConfig === "object" && !Array.isArray(channelConfig) && channelConfig.enabled === false) return true;
	}
	return (cfg.plugins?.entries?.[pluginId])?.enabled === false;
}
function isPluginDenied(cfg, pluginId) {
	const deny = cfg.plugins?.deny;
	return Array.isArray(deny) && deny.includes(pluginId);
}
function resolvePreferredOverIds(pluginId) {
	const normalized = normalizeChatChannelId(pluginId);
	if (normalized) return getChatChannelMeta(normalized).preferOver ?? [];
	return getChannelPluginCatalogEntry(pluginId)?.meta.preferOver ?? [];
}
function shouldSkipPreferredPluginAutoEnable(cfg, entry, configured) {
	for (const other of configured) {
		if (other.pluginId === entry.pluginId) continue;
		if (isPluginDenied(cfg, other.pluginId)) continue;
		if (isPluginExplicitlyDisabled(cfg, other.pluginId)) continue;
		if (resolvePreferredOverIds(other.pluginId).includes(entry.pluginId)) return true;
	}
	return false;
}
function registerPluginEntry(cfg, pluginId) {
	const builtInChannelId = normalizeChatChannelId(pluginId);
	if (builtInChannelId) {
		const existing = cfg.channels?.[builtInChannelId];
		const existingRecord = existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {};
		return {
			...cfg,
			channels: {
				...cfg.channels,
				[builtInChannelId]: {
					...existingRecord,
					enabled: true
				}
			}
		};
	}
	const entries = {
		...cfg.plugins?.entries,
		[pluginId]: {
			...cfg.plugins?.entries?.[pluginId],
			enabled: true
		}
	};
	return {
		...cfg,
		plugins: {
			...cfg.plugins,
			entries
		}
	};
}
function formatAutoEnableChange(entry) {
	let reason = entry.reason.trim();
	const channelId = normalizeChatChannelId(entry.pluginId);
	if (channelId) {
		const label = getChatChannelMeta(channelId).label;
		reason = reason.replace(new RegExp(`^${channelId}\\b`, "i"), label);
	}
	return `${reason}, enabled automatically.`;
}
function applyPluginAutoEnable(params) {
	const env = params.env ?? process.env;
	const registry = params.manifestRegistry ?? loadPluginManifestRegistry({ config: params.config });
	const configured = resolveConfiguredPlugins(params.config, env, registry);
	if (configured.length === 0) return {
		config: params.config,
		changes: []
	};
	let next = params.config;
	const changes = [];
	if (next.plugins?.enabled === false) return {
		config: next,
		changes
	};
	for (const entry of configured) {
		const builtInChannelId = normalizeChatChannelId(entry.pluginId);
		if (isPluginDenied(next, entry.pluginId)) continue;
		if (isPluginExplicitlyDisabled(next, entry.pluginId)) continue;
		if (shouldSkipPreferredPluginAutoEnable(next, entry, configured)) continue;
		const allow = next.plugins?.allow;
		const allowMissing = Array.isArray(allow) && !allow.includes(entry.pluginId);
		if ((builtInChannelId != null ? (() => {
			const channelConfig = next.channels?.[builtInChannelId];
			if (!channelConfig || typeof channelConfig !== "object" || Array.isArray(channelConfig)) return false;
			return channelConfig.enabled === true;
		})() : next.plugins?.entries?.[entry.pluginId]?.enabled === true) && !allowMissing) continue;
		next = registerPluginEntry(next, entry.pluginId);
		if (allowMissing || !builtInChannelId) next = ensurePluginAllowlisted(next, entry.pluginId);
		changes.push(formatAutoEnableChange(entry));
	}
	return {
		config: next,
		changes
	};
}

//#endregion
export { listChannelPluginCatalogEntries as a, buildChannelUiCatalog as i, isChannelConfigured as n, ensurePluginAllowlisted as r, applyPluginAutoEnable as t };