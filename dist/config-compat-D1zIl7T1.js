//#region extensions/memory-wiki/src/config-compat.ts
function asRecord(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function hasLegacyBridgeArtifactToggle(value) {
	return Object.prototype.hasOwnProperty.call(asRecord(value) ?? {}, "readMemoryCore");
}
const legacyConfigRules = [{
	path: [
		"plugins",
		"entries",
		"memory-wiki",
		"config",
		"bridge"
	],
	message: "plugins.entries.memory-wiki.config.bridge.readMemoryCore is legacy; use plugins.entries.memory-wiki.config.bridge.readMemoryArtifacts. Run \"openclaw doctor --fix\".",
	match: hasLegacyBridgeArtifactToggle
}];
function migrateMemoryWikiLegacyConfig(config) {
	const rawBridge = asRecord(asRecord(asRecord(config.plugins?.entries?.["memory-wiki"])?.config)?.bridge);
	if (!rawBridge || !hasLegacyBridgeArtifactToggle(rawBridge)) return null;
	const nextConfig = structuredClone(config);
	const nextPlugins = asRecord(nextConfig.plugins) ?? {};
	nextConfig.plugins = nextPlugins;
	const nextEntries = asRecord(nextPlugins.entries) ?? {};
	nextPlugins.entries = nextEntries;
	const nextEntry = asRecord(nextEntries["memory-wiki"]) ?? {};
	nextEntries["memory-wiki"] = nextEntry;
	const nextPluginConfig = asRecord(nextEntry.config) ?? {};
	nextEntry.config = nextPluginConfig;
	const nextBridge = asRecord(nextPluginConfig.bridge) ?? {};
	nextPluginConfig.bridge = nextBridge;
	const legacyValue = nextBridge.readMemoryCore;
	const hasCanonical = Object.prototype.hasOwnProperty.call(nextBridge, "readMemoryArtifacts");
	if (!hasCanonical) nextBridge.readMemoryArtifacts = legacyValue;
	delete nextBridge.readMemoryCore;
	return {
		config: nextConfig,
		changes: hasCanonical ? ["Removed legacy plugins.entries.memory-wiki.config.bridge.readMemoryCore; kept explicit plugins.entries.memory-wiki.config.bridge.readMemoryArtifacts."] : ["Moved plugins.entries.memory-wiki.config.bridge.readMemoryCore → plugins.entries.memory-wiki.config.bridge.readMemoryArtifacts."]
	};
}
function normalizeCompatibilityConfig({ cfg }) {
	return migrateMemoryWikiLegacyConfig(cfg) ?? {
		config: cfg,
		changes: []
	};
}
//#endregion
export { migrateMemoryWikiLegacyConfig as n, normalizeCompatibilityConfig as r, legacyConfigRules as t };
