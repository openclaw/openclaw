import {
  AllowFromListSchema,
  buildChannelConfigSchema,
} from "openclaw/plugin-sdk/channel-config-schema";
import { buildSecretInputSchema } from "openclaw/plugin-sdk/secret-input";
import { z } from "zod";

const WecomNetworkConfigSchema = z
  .object({
    egressProxyUrl: z.string().optional(),
  })
  .strict()
  .optional();

const WecomMediaConfigSchema = z
  .object({
    maxBytes: z.number().optional(),
  })
  .strict()
  .optional();

const WecomGroupConfigSchema = z
  .object({
    allowFrom: AllowFromListSchema,
  })
  .strict();

const WecomDynamicAgentsConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    dmCreateAgent: z.boolean().optional(),
    groupEnabled: z.boolean().optional(),
    adminUsers: z.array(z.string()).optional(),
  })
  .strict()
  .optional();

const WecomAccountSchema = z
  .object({
    enabled: z.boolean().optional(),
    name: z.string().optional(),
    botId: z.string().optional(),
    secret: buildSecretInputSchema().optional(),
    websocketUrl: z.string().optional(),
    allowFrom: AllowFromListSchema,
    dmPolicy: z.enum(["open", "allowlist", "pairing", "disabled"]).optional(),
    groupPolicy: z.enum(["open", "allowlist", "disabled"]).optional(),
    groupAllowFrom: AllowFromListSchema,
    groups: z.record(z.string(), WecomGroupConfigSchema).optional(),
    sendThinkingMessage: z.boolean().optional(),
    mediaLocalRoots: z.array(z.string()).optional(),
    network: WecomNetworkConfigSchema,
    media: WecomMediaConfigSchema,
    dynamicAgents: WecomDynamicAgentsConfigSchema,
  })
  .strict();

export const WecomConfigSchema = WecomAccountSchema.extend({
  accounts: z.object({}).catchall(WecomAccountSchema).optional(),
  defaultAccount: z.string().optional(),
});

export const wecomChannelConfigSchema = buildChannelConfigSchema(WecomConfigSchema);
