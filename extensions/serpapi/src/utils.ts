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

/** Reads a boolean tool argument that may arrive as a real boolean or as "true"/"false" string. */
export function readBooleanArg(args: Record<string, unknown>, key: string): boolean | undefined {
  const v = args[key];
  if (v === true || v === "true") return true;
  if (v === false || v === "false") return false;
  return undefined;
}
