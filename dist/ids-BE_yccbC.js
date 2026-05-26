import { s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { n as resolveOpenClawPackageRootSync } from "./openclaw-root-CNp1Ofdk.js";
import { p as tryReadJsonSync } from "./json-files-C2hqjU--.js";
import { n as resolveBundledPluginsDir } from "./bundled-dir-CcqVVqEn.js";
import fs from "node:fs";
import path from "node:path";
//#region src/channels/bundled-channel-catalog-read.ts
const OFFICIAL_CHANNEL_CATALOG_RELATIVE_PATH = path.join("dist", "channel-catalog.json");
const officialCatalogFileCache = /* @__PURE__ */ new Map();
const bundledPackageCatalogCache = /* @__PURE__ */ new Map();
function listPackageRoots() {
	return [resolveOpenClawPackageRootSync({ cwd: process.cwd() }), resolveOpenClawPackageRootSync({ moduleUrl: import.meta.url })].filter((entry, index, all) => Boolean(entry) && all.indexOf(entry) === index);
}
function readBundledExtensionCatalogEntriesSync() {
	const pluginsDir = resolveBundledPluginsDir();
	if (!pluginsDir) return [];
	const cached = bundledPackageCatalogCache.get(pluginsDir);
	if (cached !== void 0) return cached ?? [];
	try {
		const entries = fs.readdirSync(pluginsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).flatMap((entry) => {
			const parsed = tryReadJsonSync(path.join(pluginsDir, entry.name, "package.json"));
			return parsed ? [parsed] : [];
		});
		bundledPackageCatalogCache.set(pluginsDir, entries);
		return entries;
	} catch {
		bundledPackageCatalogCache.set(pluginsDir, null);
		return [];
	}
}
function readOfficialCatalogFileSync() {
	for (const packageRoot of listPackageRoots()) {
		const candidate = path.join(packageRoot, OFFICIAL_CHANNEL_CATALOG_RELATIVE_PATH);
		const cached = officialCatalogFileCache.get(candidate);
		if (cached !== void 0) {
			if (cached) return cached;
			continue;
		}
		if (!fs.existsSync(candidate)) {
			officialCatalogFileCache.set(candidate, null);
			continue;
		}
		const payload = tryReadJsonSync(candidate);
		if (payload) {
			const entries = Array.isArray(payload.entries) ? payload.entries : [];
			officialCatalogFileCache.set(candidate, entries);
			return entries;
		}
		officialCatalogFileCache.set(candidate, null);
	}
	return [];
}
function isChannelCatalogEntryLike(entry) {
	return "openclaw" in entry;
}
function toBundledChannelEntry(entry) {
	const channel = isChannelCatalogEntryLike(entry) ? entry.openclaw?.channel : entry;
	const id = normalizeOptionalLowercaseString(channel?.id);
	if (!id || !channel) return null;
	return {
		id,
		channel,
		aliases: Array.isArray(channel.aliases) ? channel.aliases.map((alias) => normalizeOptionalLowercaseString(alias)).filter((alias) => Boolean(alias)) : [],
		order: typeof channel.order === "number" && Number.isFinite(channel.order) ? channel.order : Number.MAX_SAFE_INTEGER
	};
}
function listBundledChannelCatalogEntries() {
	const entries = /* @__PURE__ */ new Map();
	for (const entry of readOfficialCatalogFileSync().map((entry) => toBundledChannelEntry(entry)).filter((entry) => Boolean(entry))) entries.set(entry.id, entry);
	for (const entry of readBundledExtensionCatalogEntriesSync().map((entry) => toBundledChannelEntry(entry)).filter((entry) => Boolean(entry))) entries.set(entry.id, entry);
	return Array.from(entries.values()).toSorted((left, right) => left.order - right.order || left.id.localeCompare(right.id));
}
//#endregion
//#region src/channels/ids.ts
function listBundledChatChannelEntries() {
	return listBundledChannelCatalogEntries().map((entry) => ({
		id: normalizeOptionalLowercaseString(entry.id) ?? entry.id,
		aliases: entry.aliases,
		order: entry.order
	})).toSorted((left, right) => left.order - right.order || left.id.localeCompare(right.id, "en", { sensitivity: "base" }));
}
const BUNDLED_CHAT_CHANNEL_ENTRIES = Object.freeze(listBundledChatChannelEntries());
const CHAT_CHANNEL_ID_SET = new Set(BUNDLED_CHAT_CHANNEL_ENTRIES.map((entry) => entry.id));
const CHAT_CHANNEL_ORDER = Object.freeze(BUNDLED_CHAT_CHANNEL_ENTRIES.map((entry) => entry.id));
const CHANNEL_IDS = CHAT_CHANNEL_ORDER;
const CHAT_CHANNEL_ALIASES = Object.freeze(Object.fromEntries(BUNDLED_CHAT_CHANNEL_ENTRIES.flatMap((entry) => entry.aliases.map((alias) => [alias, entry.id]))));
function normalizeChatChannelId(raw) {
	const normalized = normalizeOptionalLowercaseString(raw);
	if (!normalized) return null;
	const resolved = CHAT_CHANNEL_ALIASES[normalized] ?? normalized;
	return CHAT_CHANNEL_ID_SET.has(resolved) ? resolved : null;
}
//#endregion
export { listBundledChannelCatalogEntries as i, CHAT_CHANNEL_ORDER as n, normalizeChatChannelId as r, CHANNEL_IDS as t };
