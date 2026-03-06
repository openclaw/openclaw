import { MarkdownConfigSchema } from "openclaw/plugin-sdk/zalo";
import { z } from "zod";
import { buildSecretInputSchema } from "./secret-input.js";

const allowFromEntry = z.union([z.string(), z.number()]);

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
  allowFrom: z.array(allowFromEntry).optional(),
  mediaMaxMb: z.number().optional(),
  proxy: z.string().optional(),
  responsePrefix: z.string().optional(),
});

export const ZaloConfigSchema = zaloAccountSchema.extend({
  accounts: z.object({}).catchall(zaloAccountSchema).optional(),
  defaultAccount: z.string().optional(),
});
