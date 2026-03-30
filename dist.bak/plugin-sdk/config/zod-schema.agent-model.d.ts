import { z } from "zod";
export declare const AgentModelSchema: z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
    primary: z.ZodOptional<z.ZodString>;
    fallbacks: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$strict>]>;
