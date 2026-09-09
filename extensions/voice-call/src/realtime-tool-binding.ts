import { z } from "zod";

export const RealtimeToolBindingSchema = z
  .object({
    gatewayMethod: z.string().min(1),
    timeoutMs: z.number().int().positive().max(30_000).default(5_000),
  })
  .strict();

export const RealtimeToolSchema = z
  .object({
    type: z.literal("function"),
    name: z.string().min(1),
    description: z.string(),
    parameters: z.object({
      type: z.literal("object"),
      properties: z.record(z.string(), z.unknown()),
      required: z.array(z.string()).optional(),
    }),
  })
  .strict();

export type RealtimeToolConfig = z.infer<typeof RealtimeToolSchema>;
