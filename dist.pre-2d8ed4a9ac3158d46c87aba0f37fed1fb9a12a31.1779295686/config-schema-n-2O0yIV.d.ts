import { mt as ZodType } from "./schemas-BHWxRdiK.js";
import { n as PluginConfigUiHint } from "./manifest-types-CvQBh62X.js";
import { t as JsonSchemaObject } from "./json-schema.types-Om-hjd6G.js";
import { k as OpenClawPluginConfigSchema } from "./types-D0OCNFd4.js";

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