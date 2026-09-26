import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import type { OpenClawPluginServiceContext } from "../api.js";
import { redactSensitiveText } from "../api.js";

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

export function safeErrorMessage(err: unknown): string {
  const message = err instanceof Error ? (err.message ?? err.name) : String(err);
  return truncateUtf16Safe(
    redactSensitiveText(message)
      .replaceAll("\u0000", " ")
      .replace(/[\r\n\t\u2028\u2029]/gu, " "),
    500,
  );
}
