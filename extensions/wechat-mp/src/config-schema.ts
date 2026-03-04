import { buildChannelConfigSchema } from "openclaw/plugin-sdk";
import { z } from "zod";

const DmPolicySchema = z.enum(["open", "pairing", "allowlist"]);

const WeChatMPAccountRawSchema = z
  .object({
    enabled: z.boolean().optional(),
    appId: z.string().optional(),
    appSecret: z.string().optional(),
    token: z.string().optional(),
    webhookPath: z.string().optional(),
    rateLimitPerMinute: z.number().int().min(1).optional(),
    dmPolicy: DmPolicySchema.optional(),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
  })
  .passthrough();

export const WeChatMPConfigSchema = buildChannelConfigSchema(
  z
    .object({
      enabled: z.boolean().optional(),
      appId: z.string().optional(),
      appSecret: z.string().optional(),
      token: z.string().optional(),
      webhookPath: z.string().optional(),
      rateLimitPerMinute: z.number().int().min(1).optional(),
      dmPolicy: DmPolicySchema.optional(),
      allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
      accounts: z.record(WeChatMPAccountRawSchema).optional(),
    })
    .passthrough(),
);
