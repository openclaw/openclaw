import { La as listChannelPluginCatalogEntries } from "./reply-kqyKJg4x.js";
import { t as isTruthyEnvValue } from "./env-Cb5JzEB2.js";
import { n as CHAT_CHANNEL_ORDER } from "./registry-BbhZ8aJW.js";
import { n as listChannelPlugins } from "./plugins-By9GTgrF.js";
import { t as ensurePluginRegistryLoaded } from "./plugin-registry-DwHzCocI.js";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
//#region src/cli/channel-options.ts
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
		const base = dedupe([...CHAT_CHANNEL_ORDER, ...catalog]);
		ensurePluginRegistryLoaded();
		const pluginIds = listChannelPlugins().map((plugin) => plugin.id);
		return dedupe([...base, ...pluginIds]);
	}
	const precomputed = loadPrecomputedChannelOptions();
	const catalog = listChannelPluginCatalogEntries().map((entry) => entry.id);
	return precomputed ? dedupe([...precomputed, ...catalog]) : dedupe([...CHAT_CHANNEL_ORDER, ...catalog]);
}
function formatCliChannelOptions(extra = []) {
	return [...extra, ...resolveCliChannelOptions()].join("|");
}
//#endregion
export { resolveCliChannelOptions as n, formatCliChannelOptions as t };
