import { z } from "zod";
export declare const ChannelHeartbeatVisibilitySchema: z.ZodOptional<z.ZodObject<{
    showOk: z.ZodOptional<z.ZodBoolean>;
    showAlerts: z.ZodOptional<z.ZodBoolean>;
    useIndicator: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strict>>;
