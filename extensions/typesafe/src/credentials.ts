import { findNormalizedProviderValue } from "openclaw/plugin-sdk/model-ref-parse";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { resolveSecretInputString } from "openclaw/plugin-sdk/secret-input";
import { getPreparedPluginSecretInput } from "openclaw/plugin-sdk/secret-input-runtime";
import { providerBaseUrl, runtimeConfig, type RuntimeConfig } from "./config.js";

/** Read the active host snapshot only; never resolve refs or discover fallback credentials. */
export function resolveRuntimeConfig(
  snapshot: ReturnType<OpenClawPluginApi["runtime"]["config"]["current"]>,
): RuntimeConfig {
  const configured = snapshot.plugins?.entries?.typesafe?.config;
  const provider = findNormalizedProviderValue(snapshot.models?.providers, "typesafe");
  if (provider) {
    // Explicit provider configuration owns the entire route. In particular, do not
    // read the hosted plugin credential or inherit it when a server requires auth.
    const { timeoutMs } = runtimeConfig({ timeoutMs: configured?.timeoutMs });
    const credential = resolveSecretInputString({
      value: provider.apiKey,
      defaults: snapshot.secrets?.defaults,
      path: "models.providers.typesafe.apiKey",
      mode: "inspect",
    });
    return {
      baseUrl: providerBaseUrl(provider.baseUrl),
      providerConfig: provider,
      apiKey: credential.value,
      credentialsUnavailable: credential.status === "configured_unavailable",
      timeoutMs: provider.timeoutSeconds === undefined ? timeoutMs : provider.timeoutSeconds * 1000,
    };
  }
  const validated = runtimeConfig(configured);
  if (validated.baseUrl) {
    return validated;
  }
  const prepared = getPreparedPluginSecretInput("typesafe", "apiKey");
  return { ...validated, apiKey: prepared.value };
}
