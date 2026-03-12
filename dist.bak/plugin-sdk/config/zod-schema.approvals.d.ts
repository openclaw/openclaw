import { z } from "zod";
export declare const ApprovalsSchema: z.ZodOptional<z.ZodObject<{
    exec: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        mode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"session">, z.ZodLiteral<"targets">, z.ZodLiteral<"both">]>>;
        agentFilter: z.ZodOptional<z.ZodArray<z.ZodString>>;
        sessionFilter: z.ZodOptional<z.ZodArray<z.ZodString>>;
        targets: z.ZodOptional<z.ZodArray<z.ZodObject<{
            channel: z.ZodString;
            to: z.ZodString;
            accountId: z.ZodOptional<z.ZodString>;
            threadId: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
        }, z.core.$strict>>>;
    }, z.core.$strict>>;
}, z.core.$strict>>;
