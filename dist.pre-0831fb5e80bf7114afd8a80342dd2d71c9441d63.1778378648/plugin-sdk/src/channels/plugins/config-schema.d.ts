import { z, type ZodRawShape, type ZodTypeAny } from "zod";
import type { JsonSchemaObject } from "../../shared/json-schema.types.js";
import type { ChannelConfigSchema, ChannelConfigUiHint } from "./types.config.js";
type ExtendableZodObject = ZodTypeAny & {
    extend: (shape: Record<string, ZodTypeAny>) => ZodTypeAny;
};
export declare const AllowFromEntrySchema: z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>;
export declare const AllowFromListSchema: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
export declare function buildNestedDmConfigSchema(extraShape?: ZodRawShape): z.ZodOptional<z.ZodObject<{
    enabled: z.ZodOptional<z.ZodBoolean>;
    policy: z.ZodOptional<z.ZodEnum<{
        allowlist: "allowlist";
        disabled: "disabled";
        open: "open";
        pairing: "pairing";
    }>>;
    allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
}, z.core.$strip>>;
export declare function buildCatchallMultiAccountChannelSchema<T extends ExtendableZodObject>(accountSchema: T): T;
type BuildChannelConfigSchemaOptions = {
    uiHints?: Record<string, ChannelConfigUiHint>;
};
type BuildJsonChannelConfigSchemaOptions = {
    cacheKey?: string;
    uiHints?: Record<string, ChannelConfigUiHint>;
    runtime?: ChannelConfigSchema["runtime"];
};
export declare function buildJsonChannelConfigSchema(schema: JsonSchemaObject, options?: BuildJsonChannelConfigSchemaOptions): ChannelConfigSchema;
export declare function buildChannelConfigSchema(schema: ZodTypeAny, options?: BuildChannelConfigSchemaOptions): ChannelConfigSchema;
export declare function emptyChannelConfigSchema(): ChannelConfigSchema;
export {};
