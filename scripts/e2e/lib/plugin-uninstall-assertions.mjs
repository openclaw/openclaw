export function isExplicitPluginDisableMarker(config, pluginId) {
  const entry = config.plugins?.entries?.[pluginId];
  return (
    entry !== null &&
    typeof entry === "object" &&
    !Array.isArray(entry) &&
    entry.enabled === false &&
    Object.keys(entry).length === 1
  );
}

export function hasExpectedPluginUninstallConfigState(config, pluginId) {
  if (isExplicitPluginDisableMarker(config, pluginId)) {
    return true;
  }
  // The outer trusted workflow admits this only for a distinct frozen target.
  // That target predates the durable disable marker but still removes all plugin state.
  return (
    process.env.OPENCLAW_ALLOW_FROZEN_TARGET_SCENARIO_OMISSIONS === "1" &&
    !Object.hasOwn(config.plugins?.entries ?? {}, pluginId)
  );
}
