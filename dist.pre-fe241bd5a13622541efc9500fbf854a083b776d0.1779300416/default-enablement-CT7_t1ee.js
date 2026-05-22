//#region src/plugins/default-enablement.ts
function isPluginEnabledByDefaultForPlatform(plugin, platform = process.platform) {
	if (plugin.enabledByDefault === true) return true;
	return plugin.enabledByDefaultOnPlatforms?.includes(platform) === true;
}
//#endregion
export { isPluginEnabledByDefaultForPlatform as t };
