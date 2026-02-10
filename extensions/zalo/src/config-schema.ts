import { MarkdownConfigSchema } from "openclaw/plugin-sdk";
import { z } from "zod";

const allowFromEntry = z.union([z.string(), z.number()]);

const zaloAccountSchema = z.object({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  markdown: MarkdownConfigSchema,
  botToken: z.string().optional(),
  tokenFile: z.string().optional(),
  webhookUrl: z.string().optional(),
  webhookSecret: z.string().optional(),
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
