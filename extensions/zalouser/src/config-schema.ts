import {
  AllowFromEntrySchema,
  buildCatchallMultiAccountChannelSchema,
} from "openclaw/plugin-sdk/compat";
import { MarkdownConfigSchema, ToolPolicySchema } from "openclaw/plugin-sdk/zalouser";
import { z } from "zod";

const groupConfigSchema = z.object({
  allow: z.boolean().optional(),
  enabled: z.boolean().optional(),
  requireMention: z.boolean().optional(),
  tools: ToolPolicySchema,
});

const zalouserAccountSchema = z.object({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  markdown: MarkdownConfigSchema,
  profile: z.string().optional(),
  dmPolicy: z.enum(["pairing", "allowlist", "open", "disabled"]).optional(),
  allowFrom: z.array(AllowFromEntrySchema).optional(),
  historyLimit: z.number().int().min(0).optional(),
  groupAllowFrom: z.array(AllowFromEntrySchema).optional(),
  groupPolicy: z.enum(["disabled", "allowlist", "open"]).optional(),
  groups: z.object({}).catchall(groupConfigSchema).optional(),
  messagePrefix: z.string().optional(),
  responsePrefix: z.string().optional(),
});

export const ZalouserConfigSchema = buildCatchallMultiAccountChannelSchema(zalouserAccountSchema);
