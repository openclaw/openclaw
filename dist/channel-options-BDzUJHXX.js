import { n as CHAT_CHANNEL_ORDER } from "./ids-DFu3Ho6n.js";
import { t as readCliStartupMetadata } from "./startup-metadata-DGYmfh8l.js";
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
		const parsed = readCliStartupMetadata(import.meta.url);
		if (parsed && Array.isArray(parsed.channelOptions)) {
			precomputedChannelOptions = dedupe(parsed.channelOptions.filter((value) => typeof value === "string"));
			return precomputedChannelOptions;
		}
	} catch {}
	precomputedChannelOptions = null;
	return null;
}
function resolveCliChannelOptions() {
	return loadPrecomputedChannelOptions() ?? [...CHAT_CHANNEL_ORDER];
}
function formatCliChannelOptions(extra = []) {
	return [...extra, ...resolveCliChannelOptions()].join("|");
}
//#endregion
export { resolveCliChannelOptions as n, formatCliChannelOptions as t };
