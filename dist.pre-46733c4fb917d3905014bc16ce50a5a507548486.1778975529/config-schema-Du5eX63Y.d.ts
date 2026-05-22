import { n as PluginConfigUiHint } from "./manifest-types-SEg_8acd.js";
import { t as JsonSchemaObject } from "./json-schema.types-B7AOBX3d.js";
import { T as OpenClawPluginConfigSchema } from "./types-Dggwf5Fv.js";
import { ZodTypeAny } from "zod";

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
declare function buildPluginConfigSchema(schema: ZodTypeAny, options?: BuildPluginConfigSchemaOptions): OpenClawPluginConfigSchema;
declare function emptyPluginConfigSchema(): OpenClawPluginConfigSchema;
//#endregion
export { buildPluginConfigSchema as n, emptyPluginConfigSchema as r, buildJsonPluginConfigSchema as t };