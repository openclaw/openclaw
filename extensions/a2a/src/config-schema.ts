import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
import { z } from "zod";

const a2aPeerNamePattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const a2aHttpUrlSchema = z
  .string()
  .url()
  .and(z.string().regex(/^https?:\/\//, "A2A URLs must use HTTP or HTTPS"));

const a2aPeerConfigSchema = z
  .object({
    token: z.string().min(1),
    url: a2aHttpUrlSchema.optional(),
    outboundToken: z.string().min(1).optional(),
  })
  .strict();

const a2aCapabilitiesSchema = z
  .object({
    streaming: z.boolean().optional(),
    pushNotifications: z.boolean().optional(),
    extendedAgentCard: z.boolean().optional(),
  })
  .strict();

const a2aExtensionSchema = z
  .object({
    uri: z.string().min(1),
    description: z.string().optional(),
    required: z.boolean().optional(),
    params: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

/** Webhook egress policy for URLs registered by remote peers. */
export type A2aPushNotificationSettings = {
  /** Hostnames a peer-registered webhook may target; unset allows any public host. */
  allowedHostnames?: string[];
  /** Opt in to webhook delivery at private-network addresses. */
  allowPrivateNetwork?: boolean;
};

const a2aPushNotificationSettingsSchema = z
  .object({
    allowedHostnames: z.array(z.string().min(1)).optional(),
    allowPrivateNetwork: z.boolean().optional(),
  })
  .strict();

const a2aChannelConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    configWrites: z.boolean().optional(),
    advertisedUrl: a2aHttpUrlSchema.optional(),
    replyTimeoutMs: z.number().int().min(5_000).max(600_000).optional(),
    rateLimitPerMinute: z.number().int().min(0).optional(),
    exposeAgents: z.array(z.string()).optional(),
    peers: z.record(z.string().regex(a2aPeerNamePattern), a2aPeerConfigSchema).optional(),
    /** Capabilities advertised in the Agent Card; they also gate the gated methods. */
    capabilities: a2aCapabilitiesSchema.optional(),
    /** Serve the HTTP+JSON/REST binding alongside JSON-RPC. */
    rest: z
      .object({
        enabled: z.boolean().optional(),
      })
      .strict()
      .optional(),
    pushNotifications: a2aPushNotificationSettingsSchema.optional(),
    extensions: z.array(a2aExtensionSchema).optional(),
    /** Agent Card presentation; published to every peer that can discover the card. */
    displayName: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    documentationUrl: a2aHttpUrlSchema.optional(),
    iconUrl: a2aHttpUrlSchema.optional(),
    provider: z
      .object({
        organization: z.string().min(1).optional(),
        url: a2aHttpUrlSchema.optional(),
      })
      .strict()
      .optional(),
    inputModes: z.array(z.string().min(1)).optional(),
    outputModes: z.array(z.string().min(1)).optional(),
    /**
     * Per-agent skill descriptions published only on the authenticated extended
     * card. Agent entries themselves carry no description, so operator-authored
     * card text lives here instead of leaking into public discovery.
     */
    extendedSkillDescriptions: z.record(z.string(), z.string().min(1)).optional(),
  })
  .strict();

export type A2aPeerConfig = z.input<typeof a2aPeerConfigSchema>;
export type A2aChannelConfig = z.input<typeof a2aChannelConfigSchema>;
export type A2aCapabilitiesConfig = z.input<typeof a2aCapabilitiesSchema>;

export const a2aPluginConfigSchema = buildChannelConfigSchema(a2aChannelConfigSchema, {
  uiHints: {
    advertisedUrl: {
      label: "Advertised Gateway URL",
      help: "Public Gateway origin included in the A2A agent card.",
    },
    replyTimeoutMs: { label: "Blocking Reply Timeout (ms)", advanced: true },
    rateLimitPerMinute: { label: "Requests Per Peer Per Minute", advanced: true },
    exposeAgents: { label: "Exposed Agent IDs" },
    "peers.*.token": { label: "Inbound Bearer Token", sensitive: true },
    "peers.*.outboundToken": { label: "Outbound Bearer Token", sensitive: true },
    "capabilities.streaming": { label: "Streaming (SendStreamingMessage / SubscribeToTask)" },
    "capabilities.pushNotifications": { label: "Push Notifications", advanced: true },
    "capabilities.extendedAgentCard": { label: "Extended Agent Card", advanced: true },
    "rest.enabled": { label: "Enable HTTP+JSON/REST Binding", advanced: true },
    "pushNotifications.allowedHostnames": {
      label: "Webhook Host Allowlist",
      help: "Hostnames a peer-registered push notification URL may target.",
      advanced: true,
    },
    "pushNotifications.allowPrivateNetwork": {
      label: "Allow Private-Network Webhooks",
      advanced: true,
    },
  },
});
