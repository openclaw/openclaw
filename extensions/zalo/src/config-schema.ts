import {
  AllowFromListSchema,
  buildGroupEntrySchema,
  buildMultiAccountChannelSchema,
  DmPolicySchema,
  GroupPolicySchema,
  MarkdownConfigSchema,
} from "openclaw/plugin-sdk/channel-config-schema";
import { buildSecretInputSchema } from "openclaw/plugin-sdk/secret-input";
import { z } from "zod";

// Zalo delivers group messages only when the bot is mentioned, so requireMention is not offered.
const ZaloGroupConfigSchema = buildGroupEntrySchema(undefined, {
  omit: ["requireMention", "toolsBySender", "skills", "allowFrom", "systemPrompt"],
});

export const ZaloAccountSchema = z.object({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  configWrites: z.boolean().optional(),
  markdown: MarkdownConfigSchema,
  botToken: buildSecretInputSchema().optional(),
  tokenFile: z.string().optional(),
  webhookUrl: z.string().optional(),
  webhookSecret: buildSecretInputSchema().optional(),
  webhookPath: z.string().optional(),
  dmPolicy: DmPolicySchema.optional(),
  allowFrom: AllowFromListSchema,
  groupPolicy: GroupPolicySchema.optional(),
  groupAllowFrom: AllowFromListSchema,
  groups: z.object({}).catchall(ZaloGroupConfigSchema).optional(),
  mediaMaxMb: z.number().optional(),
  proxy: z.string().optional(),
  responsePrefix: z.string().optional(),
});

export const ZaloConfigSchema = buildMultiAccountChannelSchema(
  ZaloAccountSchema.extend({ historyLimit: z.number().int().min(0).optional() }),
  { accountSchema: ZaloAccountSchema, accountsMode: "catchall" },
);
