import { a as __toCommonJS } from "./chunk-DORXReHP.js";
import { t as isTruthyEnvValue } from "./env--LwFRA3k.js";
import { YS as listChannelPluginCatalogEntries } from "./auth-profiles-DAOR1fRn.js";
import { a as init_registry, dt as listChannelPlugins, u as registry_exports } from "./registry-ep1yQ6WN.js";
import { t as ensurePluginRegistryLoaded } from "./plugin-registry-VWAESv28.js";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
//#region src/cli/channel-options.ts
function getChatChannelOrder() {
	const { CHAT_CHANNEL_ORDER } = (init_registry(), __toCommonJS(registry_exports));
	return CHAT_CHANNEL_ORDER;
}
function dedupe(values) {
	const seen = /* @__PURE__ */ new Set();
	const resolved = [];
	for (const value of values) {
		if (!value || seen.has(value)) continue;
		seen.add(value);
		resolved.push(value);
	}
	return resolved;
}
let precomputedChannelOptions;
function loadPrecomputedChannelOptions() {
	if (precomputedChannelOptions !== void 0) return precomputedChannelOptions;
	try {
		const metadataPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "cli-startup-metadata.json");
		const raw = fs.readFileSync(metadataPath, "utf8");
		const parsed = JSON.parse(raw);
		if (Array.isArray(parsed.channelOptions)) {
			precomputedChannelOptions = dedupe(parsed.channelOptions.filter((value) => typeof value === "string"));
			return precomputedChannelOptions;
		}
	} catch {}
	precomputedChannelOptions = null;
	return null;
}
function resolveCliChannelOptions() {
	if (isTruthyEnvValue(process.env.OPENCLAW_EAGER_CHANNEL_OPTIONS)) {
		const catalog = listChannelPluginCatalogEntries().map((entry) => entry.id);
		const base = dedupe([...getChatChannelOrder(), ...catalog]);
		ensurePluginRegistryLoaded();
		const pluginIds = listChannelPlugins().map((plugin) => plugin.id);
		return dedupe([...base, ...pluginIds]);
	}
	const precomputed = loadPrecomputedChannelOptions();
	const catalog = listChannelPluginCatalogEntries().map((entry) => entry.id);
	return precomputed ? dedupe([...precomputed, ...catalog]) : dedupe([...getChatChannelOrder(), ...catalog]);
}
function formatCliChannelOptions(extra = []) {
	return [...extra, ...resolveCliChannelOptions()].join("|");
}
//#endregion
export { resolveCliChannelOptions as n, formatCliChannelOptions as t };
