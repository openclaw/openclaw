import { z, type ZodTypeAny } from "zod";
import type { ChannelConfigSchema } from "./types.plugin.js";
type ExtendableZodObject = ZodTypeAny & {
    extend: (shape: Record<string, ZodTypeAny>) => ZodTypeAny;
};
export declare const AllowFromEntrySchema: z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>;
export declare const AllowFromListSchema: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
export declare function buildNestedDmConfigSchema(): z.ZodOptional<z.ZodObject<{
    enabled: z.ZodOptional<z.ZodBoolean>;
    policy: z.ZodOptional<z.ZodEnum<{
        allowlist: "allowlist";
        open: "open";
        disabled: "disabled";
        pairing: "pairing";
    }>>;
    allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
}, z.core.$strip>>;
export declare function buildCatchallMultiAccountChannelSchema<T extends ExtendableZodObject>(accountSchema: T): T;
export declare function buildChannelConfigSchema(schema: ZodTypeAny): ChannelConfigSchema;
export {};
