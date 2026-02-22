import { MarkdownConfigSchema } from "openclaw/plugin-sdk";
import { z } from "zod";

const allowFromEntry = z.union([z.string(), z.number()]);

const tuituiAccountSchema = z.object({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  markdown: MarkdownConfigSchema,
  appId: z.string().optional(),
  secret: z.string().optional(),
  secretFile: z.string().optional(),
  webhookPath: z.string().optional(),
  webhookBaseUrl: z.string().optional(),
  dmPolicy: z.enum(["pairing", "allowlist", "open", "disabled"]).optional(),
  allowFrom: z.array(allowFromEntry).optional(),
  responsePrefix: z.string().optional(),
});

export const TuituiConfigSchema = tuituiAccountSchema.extend({
  accounts: z.object({}).catchall(tuituiAccountSchema).optional(),
  defaultAccount: z.string().optional(),
});
