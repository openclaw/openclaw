import { MarkdownConfigSchema } from "clawdbot/plugin-sdk";
import { z } from "zod";

const allowFromEntry = z.union([z.string(), z.number()]);

const kakaoAccountSchema = z.object({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  markdown: MarkdownConfigSchema,
  appKey: z.string().optional(),
  keyFile: z.string().optional(),
  callbackUrl: z.string().optional(),
  callbackPath: z.string().optional(),
  dmPolicy: z.enum(["pairing", "allowlist", "open", "disabled"]).optional(),
  allowFrom: z.array(allowFromEntry).optional(),
  mediaMaxMb: z.number().optional(),
  proxy: z.string().optional(),
});

export const KakaoConfigSchema = kakaoAccountSchema.extend({
  accounts: z.object({}).catchall(kakaoAccountSchema).optional(),
  defaultAccount: z.string().optional(),
});
