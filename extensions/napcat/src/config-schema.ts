import { DmPolicySchema, GroupPolicySchema } from "openclaw/plugin-sdk";
import { z } from "zod";

const allowFromEntry = z.union([z.string(), z.number()]);

const napCatDmSchema = z
  .object({
    enabled: z.boolean().optional(),
    policy: DmPolicySchema.optional(),
    allowFrom: z.array(allowFromEntry).optional(),
  })
  .optional();

const napCatHttpTransportSchema = z
  .object({
    enabled: z.boolean().optional(),
    host: z.string().optional(),
    port: z.number().int().min(1).max(65535).optional(),
    path: z.string().optional(),
    bodyMaxBytes: z.number().int().positive().optional(),
  })
  .optional();

const napCatWsTransportSchema = z
  .object({
    enabled: z.boolean().optional(),
    url: z.string().optional(),
    reconnectMs: z.number().int().positive().optional(),
  })
  .optional();

const napCatGroupSchema = z
  .object({
    enabled: z.boolean().optional(),
    allow: z.boolean().optional(),
    requireMention: z.boolean().optional(),
    allowFrom: z.array(allowFromEntry).optional(),
  })
  .optional();

export const NapCatConfigSchema = z.object({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  token: z.string().optional(),
  apiBaseUrl: z.string().optional(),
  defaultTo: z.string().optional(),
  dm: napCatDmSchema,
  groupPolicy: GroupPolicySchema.optional(),
  groupAllowFrom: z.array(allowFromEntry).optional(),
  groups: z.object({}).catchall(napCatGroupSchema).optional(),
  transport: z
    .object({
      http: napCatHttpTransportSchema,
      ws: napCatWsTransportSchema,
    })
    .optional(),
  replyToMode: z.enum(["off", "first", "all"]).optional(),
  blockStreaming: z.boolean().optional(),
  mediaMaxMb: z.number().positive().optional(),
});
