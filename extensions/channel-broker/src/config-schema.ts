import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
import { buildSecretInputSchema } from "openclaw/plugin-sdk/secret-input";
import { z } from "zod";

const BrokerPlatformCapabilitiesSchema = z
  .object({
    inbound: z.boolean().optional(),
    outbound: z.boolean().optional(),
    receipts: z.boolean().optional(),
    threads: z.boolean().optional(),
    topics: z.boolean().optional(),
    attachments: z.boolean().optional(),
    reactions: z.boolean().optional(),
    edits: z.boolean().optional(),
    deletes: z.boolean().optional(),
    draftPreview: z.boolean().optional(),
    progressPreview: z.boolean().optional(),
    finalEdit: z.boolean().optional(),
    businessApi: z.boolean().optional(),
    deviceBound: z.boolean().optional(),
    selfHosted: z.boolean().optional(),
  })
  .strict();

const ProviderSchema = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    baseUrl: z.string().url().optional(),
    outboundToken: buildSecretInputSchema().optional(),
    signingSecret: buildSecretInputSchema().optional(),
    accountId: z.string().optional(),
    platforms: z.array(z.string()).optional(),
    platformAliases: z.record(z.string(), z.string()).optional(),
    defaultPlatform: z.string().optional(),
    defaultConversationType: z.enum(["direct", "group", "channel", "thread"]).optional(),
    defaultTo: z.string().optional(),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    capabilities: z.record(z.string(), BrokerPlatformCapabilitiesSchema).optional(),
  })
  .strict();

const ChannelBrokerConfigSchema = ProviderSchema.extend({
  accounts: z.record(z.string(), ProviderSchema.partial()).optional(),
  providers: z.record(z.string(), ProviderSchema.partial()).optional(),
  defaultAccount: z.string().optional(),
  defaultProviderId: z.string().optional(),
}).strict();

export const channelBrokerPluginConfigSchema = buildChannelConfigSchema(ChannelBrokerConfigSchema);
