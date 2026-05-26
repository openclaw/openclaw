import { t as JsonSchemaObject } from "./json-schema.types-DNwd-gAi.js";
import { n as ChannelConfigSchema, r as ChannelConfigUiHint } from "./types.config-U9f3z9SA.js";
import { ZodRawShape, ZodTypeAny, z } from "zod";

//#region src/channels/plugins/config-schema.d.ts
type ExtendableZodObject = ZodTypeAny & {
  extend: (shape: Record<string, ZodTypeAny>) => ZodTypeAny;
};
declare const AllowFromListSchema: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
declare function buildNestedDmConfigSchema(extraShape?: ZodRawShape): z.ZodOptional<z.ZodObject<{
  enabled: z.ZodOptional<z.ZodBoolean>;
  policy: z.ZodOptional<z.ZodEnum<{
    pairing: "pairing";
    disabled: "disabled";
    allowlist: "allowlist";
    open: "open";
  }>>;
  allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
}, z.core.$strip>>;
declare function buildCatchallMultiAccountChannelSchema<T extends ExtendableZodObject>(accountSchema: T): T;
type BuildChannelConfigSchemaOptions = {
  uiHints?: Record<string, ChannelConfigUiHint>;
};
type BuildJsonChannelConfigSchemaOptions = {
  cacheKey?: string;
  uiHints?: Record<string, ChannelConfigUiHint>;
  runtime?: ChannelConfigSchema["runtime"];
};
declare function buildJsonChannelConfigSchema(schema: JsonSchemaObject, options?: BuildJsonChannelConfigSchemaOptions): ChannelConfigSchema;
declare function buildChannelConfigSchema(schema: ZodTypeAny, options?: BuildChannelConfigSchemaOptions): ChannelConfigSchema;
declare function emptyChannelConfigSchema(): ChannelConfigSchema;
//#endregion
export { buildNestedDmConfigSchema as a, buildJsonChannelConfigSchema as i, buildCatchallMultiAccountChannelSchema as n, emptyChannelConfigSchema as o, buildChannelConfigSchema as r, AllowFromListSchema as t };