import { AllowFromEntrySchema, buildCatchallMultiAccountChannelSchema } from "openclaw/plugin-sdk";
import { MarkdownConfigSchema } from "openclaw/plugin-sdk/zalo";
import { z } from "zod";
import { buildSecretInputSchema } from "./secret-input.js";

const zaloAccountSchema = z.object({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  markdown: MarkdownConfigSchema,
  botToken: buildSecretInputSchema().optional(),
  tokenFile: z.string().optional(),
  webhookUrl: z.string().optional(),
  webhookSecret: buildSecretInputSchema().optional(),
  webhookPath: z.string().optional(),
  dmPolicy: z.enum(["pairing", "allowlist", "open", "disabled"]).optional(),
  allowFrom: z.array(AllowFromEntrySchema).optional(),
  groupPolicy: z.enum(["disabled", "allowlist", "open"]).optional(),
  groupAllowFrom: z.array(AllowFromEntrySchema).optional(),
  mediaMaxMb: z.number().optional(),
  proxy: z.string().optional(),
  responsePrefix: z.string().optional(),
});

export const ZaloConfigSchema = buildCatchallMultiAccountChannelSchema(zaloAccountSchema);
