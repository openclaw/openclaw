import {
  AllowFromListSchema,
  buildChannelConfigSchema,
} from "openclaw/plugin-sdk/channel-config-schema";
import { buildSecretInputSchema } from "openclaw/plugin-sdk/secret-input";
import { z } from "zod";

const WecomAgentConfigSchema = z
  .object({
    corpId: z.string().optional(),
    corpSecret: buildSecretInputSchema().optional(),
    agentId: z.union([z.string(), z.number()]).optional(),
    token: z.string().optional(),
    encodingAESKey: z.string().optional(),
    configured: z.boolean().optional(),
  })
  .strict()
  .optional();

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
    agent: WecomAgentConfigSchema,
    network: WecomNetworkConfigSchema,
    media: WecomMediaConfigSchema,
    dynamicAgents: WecomDynamicAgentsConfigSchema,
    // Webhook mode fields
    connectionMode: z.enum(["webhook", "websocket"]).optional(),
    token: z.string().optional(),
    encodingAESKey: z.string().optional(),
    receiveId: z.string().optional(),
    welcomeText: z.string().optional(),
    streamPlaceholderContent: z.string().optional(),
  })
  .strict();

export const WecomConfigSchema = WecomAccountSchema.extend({
  accounts: z.object({}).catchall(WecomAccountSchema).optional(),
  defaultAccount: z.string().optional(),
});

export const wecomChannelConfigSchema = buildChannelConfigSchema(WecomConfigSchema);
