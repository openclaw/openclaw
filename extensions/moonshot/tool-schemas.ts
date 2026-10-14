import type { ProviderNormalizeToolSchemasContext } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeKimiToolSchemas } from "openclaw/plugin-sdk/provider-tools";
import { isNativeMoonshotBaseUrl } from "./provider-policy-api.js";

/** Applies Kimi schema compatibility only to Moonshot's evidenced first-party endpoints. */
export function normalizeNativeMoonshotToolSchemas(ctx: ProviderNormalizeToolSchemasContext) {
  return isNativeMoonshotBaseUrl(ctx.model?.baseUrl) ? normalizeKimiToolSchemas(ctx) : ctx.tools;
}
