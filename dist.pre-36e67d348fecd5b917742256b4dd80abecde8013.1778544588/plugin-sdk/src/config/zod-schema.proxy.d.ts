import { z } from "zod";
export declare const ProxyConfigSchema: z.ZodOptional<z.ZodObject<{
    enabled: z.ZodOptional<z.ZodBoolean>;
    proxyUrl: z.ZodOptional<z.ZodString>;
}, z.core.$strict>>;
export type ProxyConfig = z.infer<typeof ProxyConfigSchema>;
