import { type ZodTypeAny } from "zod";
import type { JsonSchemaObject } from "../shared/json-schema.types.js";
import type { PluginConfigUiHint } from "./manifest-types.js";
import type { OpenClawPluginConfigSchema } from "./types.js";
type BuildPluginConfigSchemaOptions = {
    uiHints?: Record<string, PluginConfigUiHint>;
    safeParse?: OpenClawPluginConfigSchema["safeParse"];
};
type BuildJsonPluginConfigSchemaOptions = {
    cacheKey?: string;
    uiHints?: Record<string, PluginConfigUiHint>;
    safeParse?: OpenClawPluginConfigSchema["safeParse"];
};
export declare function buildJsonPluginConfigSchema(schema: JsonSchemaObject, options?: BuildJsonPluginConfigSchemaOptions): OpenClawPluginConfigSchema;
export declare function buildPluginConfigSchema(schema: ZodTypeAny, options?: BuildPluginConfigSchemaOptions): OpenClawPluginConfigSchema;
export declare function emptyPluginConfigSchema(): OpenClawPluginConfigSchema;
export {};
