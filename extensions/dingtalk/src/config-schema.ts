/**
 * DingTalk channel config Zod schema for validation and defaults.
 */

import { buildChannelConfigSchema } from "openclaw/plugin-sdk";
import { z } from "zod";

const DmPolicySchema = z.enum(["open", "pairing", "allowlist"]);

const DingTalkAccountRawSchema = z
  .object({
    enabled: z.boolean().optional(),
    appKey: z.string().optional(),
    appSecret: z.string().optional(),
    corpId: z.string().optional(),
    webhookPath: z.string().optional(),
    rateLimitPerMinute: z.number().int().min(1).optional(),
    dmPolicy: DmPolicySchema.optional(),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
  })
  .passthrough();

export const DingTalkConfigSchema = buildChannelConfigSchema(
  z
    .object({
      enabled: z.boolean().optional(),
      appKey: z.string().optional(),
      appSecret: z.string().optional(),
      corpId: z.string().optional(),
      webhookPath: z.string().optional(),
      rateLimitPerMinute: z.number().int().min(1).optional(),
      dmPolicy: DmPolicySchema.optional(),
      allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
      accounts: z.record(DingTalkAccountRawSchema).optional(),
    })
    .passthrough(),
);

export type DingTalkConfigSchemaType = z.infer<typeof DingTalkConfigSchema>["schema"];
