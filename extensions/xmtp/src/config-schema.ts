import { MarkdownConfigSchema, buildChannelConfigSchema } from "openclaw/plugin-sdk";
import { z } from "zod";

export const XmtpConfigSchema = z.object({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  markdown: MarkdownConfigSchema,

  walletKey: z.string().optional(),
  walletKeyFile: z.string().optional(),
  dbEncryptionKey: z.string().optional(),
  dbEncryptionKeyFile: z.string().optional(),

  env: z.enum(["local", "dev", "production"]).optional(),
  dbPath: z.string().optional(),

  dmPolicy: z.enum(["pairing", "allowlist", "open", "disabled"]).optional(),
  allowFrom: z.array(z.string()).optional(),
});

export type XmtpConfig = z.infer<typeof XmtpConfigSchema>;

export const xmtpChannelConfigSchema = buildChannelConfigSchema(XmtpConfigSchema);
