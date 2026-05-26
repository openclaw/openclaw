import { n as normalizeAccountId } from "./account-id-B32J-iNN.js";
import { n as getActivePluginChannelRegistryVersion } from "./runtime-DHxRl5F1.js";
import { a as normalizeChannelId, i as listChannelPlugins } from "./registry-Bf5TpUad.js";
import "./plugins-DYTHbmt7.js";
import { t as resolveAccountEntry } from "./account-lookup-CQEoGO1F.js";
//#region src/config/markdown-tables.ts
function buildDefaultTableModes() {
	return new Map(listChannelPlugins().flatMap((plugin) => {
		const defaultMarkdownTableMode = plugin.messaging?.defaultMarkdownTableMode;
		return defaultMarkdownTableMode ? [[plugin.id, defaultMarkdownTableMode]] : [];
	}).toSorted(([left], [right]) => left.localeCompare(right)));
}
let cachedDefaultTableModes = null;
let cachedDefaultTableModesRegistryVersion = null;
function getDefaultTableModes() {
	const registryVersion = getActivePluginChannelRegistryVersion();
	if (!cachedDefaultTableModes || cachedDefaultTableModesRegistryVersion !== registryVersion) {
		cachedDefaultTableModes = buildDefaultTableModes();
		cachedDefaultTableModesRegistryVersion = registryVersion;
	}
	return cachedDefaultTableModes;
}
const EMPTY_DEFAULT_TABLE_MODES = /* @__PURE__ */ new Map();
function bindDefaultTableModesMethod(value) {
	if (typeof value !== "function") return value;
	return value.bind(getDefaultTableModes());
}
new Proxy(EMPTY_DEFAULT_TABLE_MODES, { get(_target, prop, _receiver) {
	return bindDefaultTableModesMethod(Reflect.get(getDefaultTableModes(), prop));
} });
const isMarkdownTableMode = (value) => value === "off" || value === "bullets" || value === "code" || value === "block";
function resolveMarkdownModeFromSection(section, accountId) {
	if (!section) return;
	const normalizedAccountId = normalizeAccountId(accountId);
	const accounts = section.accounts;
	if (accounts && typeof accounts === "object") {
		const matchMode = resolveAccountEntry(accounts, normalizedAccountId)?.markdown?.tables;
		if (isMarkdownTableMode(matchMode)) return matchMode;
	}
	const sectionMode = section.markdown?.tables;
	return isMarkdownTableMode(sectionMode) ? sectionMode : void 0;
}
function resolveMarkdownTableMode(params) {
	const channel = normalizeChannelId(params.channel);
	const defaultMode = channel ? getDefaultTableModes().get(channel) ?? "code" : "code";
	if (!channel || !params.cfg) return defaultMode;
	const resolved = resolveMarkdownModeFromSection(params.cfg.channels?.[channel] ?? params.cfg?.[channel], params.accountId) ?? defaultMode;
	return resolved === "block" ? "code" : resolved;
}
//#endregion
export { resolveMarkdownTableMode as t };
