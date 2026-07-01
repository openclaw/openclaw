// Tavily helper module supports tavily tool config behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { isSecretRef } from "openclaw/plugin-sdk/secret-input";
import { resolveTavilySearchConfig } from "./config.js";

export type TavilyToolConfigContext = Pick<
  OpenClawPluginToolContext,
  "config" | "runtimeConfig" | "getRuntimeConfig" | "credentialBroker"
>;

export function resolveTavilyToolConfig(
  api: OpenClawPluginApi,
  ctx?: TavilyToolConfigContext,
): OpenClawConfig {
  return ctx?.getRuntimeConfig?.() ?? ctx?.runtimeConfig ?? ctx?.config ?? api.config;
}

export function tavilyToolRequiresCredentialBroker(ctx?: TavilyToolConfigContext): boolean {
  return isSecretRef(resolveTavilySearchConfig(ctx?.config)?.apiKey);
}
