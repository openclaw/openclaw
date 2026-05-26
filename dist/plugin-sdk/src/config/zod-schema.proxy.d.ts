import { z } from "zod";
export declare const ProxyLoopbackModeSchema: z.ZodEnum<{
    block: "block";
    "gateway-only": "gateway-only";
    proxy: "proxy";
}>;
export declare const ProxyConfigSchema: z.ZodOptional<z.ZodObject<{
    enabled: z.ZodOptional<z.ZodBoolean>;
    proxyUrl: z.ZodOptional<z.ZodURL>;
    tls: z.ZodOptional<z.ZodObject<{
        caFile: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
    loopbackMode: z.ZodOptional<z.ZodEnum<{
        block: "block";
        "gateway-only": "gateway-only";
        proxy: "proxy";
    }>>;
}, z.core.$strict>>;
export type ProxyConfig = z.infer<typeof ProxyConfigSchema>;
