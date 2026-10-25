import type { OpenClawPluginServiceContext } from "../api.js";

export function isProviderUsagePollingEnabled(
  config: OpenClawPluginServiceContext["config"],
): boolean {
  const pluginConfig = config.plugins?.entries?.["diagnostics-prometheus"]?.config;
  if (!pluginConfig || typeof pluginConfig !== "object" || Array.isArray(pluginConfig)) {
    return false;
  }
  // SAFETY: The object/array guard above leaves a record; providerUsage stays unknown until checked.
  const providerUsage = (pluginConfig as Record<string, unknown>).providerUsage;
  return (
    providerUsage !== null &&
    typeof providerUsage === "object" &&
    !Array.isArray(providerUsage) &&
    // SAFETY: The object/array guard above leaves a record; enabled is compared before use.
    (providerUsage as Record<string, unknown>).enabled === true
  );
}
