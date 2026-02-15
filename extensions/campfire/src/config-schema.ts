import { buildChannelConfigSchema } from "openclaw/plugin-sdk";
import { z } from "zod";

const allowFromEntry = z.union([z.string(), z.number()]);

const campfireGroupConfigSchema = z.object({
  enabled: z.boolean().optional(),
  allow: z.boolean().optional(),
  requireMention: z.boolean().optional(),
  users: z.array(allowFromEntry).optional(),
  systemPrompt: z.string().optional(),
});

const campfireDmConfigSchema = z.object({
  policy: z.enum(["disabled", "pairing", "allowlist", "open"]).optional(),
  enabled: z.boolean().optional(),
  allowFrom: z.array(allowFromEntry).optional(),
});

const campfireAccountSchema = z.object({
  enabled: z.boolean().optional(),
  name: z.string().optional(),
  baseUrl: z.string().optional(),
  botKey: z.string().optional(),
  webhookPath: z.string().optional(),
  mediaMaxMb: z.number().optional(),
  textChunkLimit: z.number().optional(),
  dm: campfireDmConfigSchema.optional(),
  groups: z.record(z.string(), campfireGroupConfigSchema).optional(),
  groupPolicy: z.enum(["disabled", "allowlist", "open"]).optional(),
  groupAllowFrom: z.array(allowFromEntry).optional(),
  requireMention: z.boolean().optional(),
});

export const CampfireConfigSchema = campfireAccountSchema.extend({
  defaultAccount: z.string().optional(),
  accounts: z.record(z.string(), campfireAccountSchema).optional(),
});

export const campfireChannelConfigSchema = buildChannelConfigSchema(CampfireConfigSchema);
