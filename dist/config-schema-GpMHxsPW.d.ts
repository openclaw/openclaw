import { mt as ZodType } from "./schemas-CkRCGSfd.js";
import { n as PluginConfigUiHint } from "./manifest-types-C_IWdo1j.js";
import { t as JsonSchemaObject } from "./json-schema.types-fpZiub1R.js";
import { k as OpenClawPluginConfigSchema } from "./types-Vx7Jq4_-2.js";

//#region src/plugins/config-schema.d.ts
type BuildPluginConfigSchemaOptions = {
  uiHints?: Record<string, PluginConfigUiHint>;
  safeParse?: OpenClawPluginConfigSchema["safeParse"];
};
type BuildJsonPluginConfigSchemaOptions = {
  cacheKey?: string;
  uiHints?: Record<string, PluginConfigUiHint>;
  safeParse?: OpenClawPluginConfigSchema["safeParse"];
};
declare function buildJsonPluginConfigSchema(schema: JsonSchemaObject, options?: BuildJsonPluginConfigSchemaOptions): OpenClawPluginConfigSchema;
declare function buildPluginConfigSchema(schema: ZodType, options?: BuildPluginConfigSchemaOptions): OpenClawPluginConfigSchema;
declare function emptyPluginConfigSchema(): OpenClawPluginConfigSchema;
//#endregion
export { buildPluginConfigSchema as n, emptyPluginConfigSchema as r, buildJsonPluginConfigSchema as t };