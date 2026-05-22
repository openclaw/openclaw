import { C as ZodEnum, Q as ZodOptional, Y as ZodNumber, Z as ZodObject, bt as ZodUnion, c as ZodBoolean, mt as ZodType, r as ZodArray, ra as $strip, st as ZodString } from "./schemas-BHWxRdiK.js";
import { i as ZodRawShape } from "./compat-zFcm8NuS.js";
import { t as JsonSchemaObject } from "./json-schema.types-Om-hjd6G.js";
import { n as ChannelConfigSchema, r as ChannelConfigUiHint } from "./types.config-B8WlQzf0.js";

//#region src/channels/plugins/config-schema.d.ts
type ExtendableZodObject = ZodType & {
  extend: (shape: Record<string, ZodType>) => ZodType;
};
declare const AllowFromListSchema: ZodOptional<ZodArray<ZodUnion<readonly [ZodString, ZodNumber]>>>;
declare function buildNestedDmConfigSchema(extraShape?: ZodRawShape): ZodOptional<ZodObject<{
  enabled: ZodOptional<ZodBoolean>;
  policy: ZodOptional<ZodEnum<{
    disabled: "disabled";
    allowlist: "allowlist";
    pairing: "pairing";
    open: "open";
  }>>;
  allowFrom: ZodOptional<ZodArray<ZodUnion<readonly [ZodString, ZodNumber]>>>;
}, $strip>>;
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
declare function buildChannelConfigSchema(schema: ZodType, options?: BuildChannelConfigSchemaOptions): ChannelConfigSchema;
declare function emptyChannelConfigSchema(): ChannelConfigSchema;
//#endregion
export { buildNestedDmConfigSchema as a, buildJsonChannelConfigSchema as i, buildCatchallMultiAccountChannelSchema as n, emptyChannelConfigSchema as o, buildChannelConfigSchema as r, AllowFromListSchema as t };