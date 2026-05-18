import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";

export type SerpApiToolCtx = Pick<
  OpenClawPluginToolContext,
  "config" | "runtimeConfig" | "getRuntimeConfig"
>;

export function resolveToolConfig(api: OpenClawPluginApi, ctx?: SerpApiToolCtx): OpenClawConfig {
  return ctx?.getRuntimeConfig?.() ?? ctx?.runtimeConfig ?? ctx?.config ?? api.config;
}
