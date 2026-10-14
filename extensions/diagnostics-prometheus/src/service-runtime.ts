import type { OpenClawPluginServiceContext } from "../api.js";

export function isProviderUsagePollingEnabled(
  config: OpenClawPluginServiceContext["config"],
): boolean {
  const pluginConfig = config.plugins?.entries?.["diagnostics-prometheus"]?.config;
  if (!pluginConfig || typeof pluginConfig !== "object" || Array.isArray(pluginConfig)) {
    return false;
  }
  const providerUsage = (pluginConfig as Record<string, unknown>).providerUsage;
  return (
    providerUsage !== null &&
    typeof providerUsage === "object" &&
    !Array.isArray(providerUsage) &&
    (providerUsage as Record<string, unknown>).enabled === true
  );
}
