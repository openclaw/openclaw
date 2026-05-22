//#region extensions/google-meet/src/config-compat.ts
function asRecord(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function normalizeProviderId(value) {
	return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : void 0;
}
function hasOwn(record, key) {
	return Object.prototype.hasOwnProperty.call(record, key);
}
function hasLegacyGoogleRealtimeProvider(value) {
	const realtime = asRecord(value);
	if (!realtime || normalizeProviderId(realtime.provider) !== "google") return false;
	return !hasOwn(realtime, "voiceProvider") || !hasOwn(realtime, "transcriptionProvider");
}
const legacyConfigRules = [{
	path: [
		"plugins",
		"entries",
		"google-meet",
		"config",
		"realtime"
	],
	message: "plugins.entries.google-meet.config.realtime.provider=\"google\" is legacy for Gemini Live bidi mode; use realtime.voiceProvider=\"google\" and realtime.transcriptionProvider=\"openai\". Run \"openclaw doctor --fix\".",
	match: hasLegacyGoogleRealtimeProvider
}];
function migrateGoogleMeetLegacyRealtimeProvider(config) {
	const rawRealtime = asRecord(asRecord(asRecord(config.plugins?.entries?.["google-meet"])?.config)?.realtime);
	if (!rawRealtime || !hasLegacyGoogleRealtimeProvider(rawRealtime)) return null;
	const nextConfig = structuredClone(config);
	const nextPlugins = asRecord(nextConfig.plugins) ?? {};
	nextConfig.plugins = nextPlugins;
	const nextEntries = asRecord(nextPlugins.entries) ?? {};
	nextPlugins.entries = nextEntries;
	const nextEntry = asRecord(nextEntries["google-meet"]) ?? {};
	nextEntries["google-meet"] = nextEntry;
	const nextPluginConfig = asRecord(nextEntry.config) ?? {};
	nextEntry.config = nextPluginConfig;
	const nextRealtime = asRecord(nextPluginConfig.realtime) ?? {};
	nextPluginConfig.realtime = nextRealtime;
	nextRealtime.provider = "openai";
	if (!hasOwn(nextRealtime, "transcriptionProvider")) nextRealtime.transcriptionProvider = "openai";
	if (!hasOwn(nextRealtime, "voiceProvider")) nextRealtime.voiceProvider = "google";
	return {
		config: nextConfig,
		changes: ["Moved Google Meet legacy realtime.provider=\"google\" intent to realtime.voiceProvider=\"google\" and realtime.transcriptionProvider=\"openai\"."]
	};
}
function normalizeCompatibilityConfig({ cfg }) {
	return migrateGoogleMeetLegacyRealtimeProvider(cfg) ?? {
		config: cfg,
		changes: []
	};
}
//#endregion
export { legacyConfigRules, normalizeCompatibilityConfig };
