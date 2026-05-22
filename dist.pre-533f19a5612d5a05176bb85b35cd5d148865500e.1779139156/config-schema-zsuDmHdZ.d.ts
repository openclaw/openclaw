import { mt as ZodType } from "./schemas-BLtfSuMt.js";
import { n as PluginConfigUiHint } from "./manifest-types-Cmbj63Ty.js";
import { t as JsonSchemaObject } from "./json-schema.types-BYet9RVQ.js";
import { k as OpenClawPluginConfigSchema } from "./types-Cdl1yOYR.js";

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