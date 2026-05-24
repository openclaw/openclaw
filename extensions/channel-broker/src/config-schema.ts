import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
import { buildSecretInputSchema } from "openclaw/plugin-sdk/secret-input";
import { z } from "zod";

const BrokerDeliveryRequirementsSchema = z
  .object({
    text: z.boolean().optional(),
    media: z.boolean().optional(),
    payload: z.boolean().optional(),
    silent: z.boolean().optional(),
    replyTo: z.boolean().optional(),
    thread: z.boolean().optional(),
    nativeQuote: z.boolean().optional(),
    previewFinalization: z.boolean().optional(),
    progressUpdates: z.boolean().optional(),
    nativeStreaming: z.boolean().optional(),
    reconcileUnknownSend: z.boolean().optional(),
  })
  .strict();

const BrokerLiveCapabilitiesSchema = z
  .object({
    draftPreview: z.boolean().optional(),
    previewFinalization: z.boolean().optional(),
    progressUpdates: z.boolean().optional(),
  })
  .strict();

const BrokerReceiveCapabilitiesSchema = z
  .object({
    webhook: z.boolean().optional(),
    polling: z.boolean().optional(),
    ackAfterDurableSend: z.boolean().optional(),
    manualAck: z.boolean().optional(),
  })
  .strict();

const BrokerPlatformCapabilitiesSchema = z
  .object({
    platform: z.string().optional(),
    delivery: BrokerDeliveryRequirementsSchema.optional(),
    live: BrokerLiveCapabilitiesSchema.optional(),
    receive: BrokerReceiveCapabilitiesSchema.optional(),
    native: z.record(z.string(), z.boolean()).optional(),
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
