import {
  buildChannelConfigSchema,
  buildChannelAccountSchemaParts,
  ChannelDangerouslyAllowNameMatchingSchema,
  ChannelPreviewStreamingConfigSchema,
  MSTeamsReplyStyleSchema,
  ToolPolicySchema,
} from "openclaw/plugin-sdk/channel-config-schema";
import { createChannelConfigUiHints } from "openclaw/plugin-sdk/channel-core";
import type { ChannelConfigUiHint } from "openclaw/plugin-sdk/channel-core";
import {
  buildSecretInputSchema,
  registerSensitiveConfigSchema,
} from "openclaw/plugin-sdk/secret-input";
import { z } from "zod";
import { isAllowedBotFrameworkServiceUrl } from "./bot-framework-service-url.js";
import { refineMSTeamsConfig } from "./config-schema-refinement.js";

const msTeamsChannelConfigUiHints = {
  "": {
    label: "MS Teams",
    help: "Microsoft Teams channel provider configuration and provider-specific policy toggles. Use this section to isolate Teams behavior from other enterprise chat providers.",
  },
  configWrites: {
    label: "MS Teams Config Writes",
    help: "Allow Microsoft Teams to write config in response to channel events/commands (default: true).",
  },
  cloud: {
    label: "MS Teams Cloud",
    help: 'Teams SDK cloud environment for auth, token validation, and token services: "Public", "USGov", "USGovDoD", or "China" (default: Public).',
  },
  serviceUrl: {
    label: "MS Teams Service URL",
    help: "Bot Connector service URL for SDK proactive sends/edits/deletes. Set with cloud for USGov/DoD; set alone for GCC.",
  },
  graphMediaFallback: {
    label: "MS Teams Graph Media Fallback",
    help: "Query Microsoft Graph for unresolved channel or group-chat HTML media. Adds one lookup per matching message when enabled (default: false).",
  },
  requireMentionInBotThreads: {
    label: "Require Mentions in Bot Threads",
    help: "Override mention requirements for channel threads rooted at this bot's tracked messages. Unset preserves existing behavior. Channel overrides win over team and global values. Ownership tracking lasts up to 24 hours.",
  },
  "teams.*.requireMentionInBotThreads": {
    label: "Team Bot Thread Mentions",
    help: "Override mention requirements for this bot's channel threads in this team. Unset inherits the global value.",
  },
  "teams.*.channels.*.requireMentionInBotThreads": {
    label: "Channel Bot Thread Mentions",
    help: "Override mention requirements for this bot's threads in this channel. Unset inherits the team or global value.",
  },
  ...createChannelConfigUiHints({
    channelLabel: "MS Teams",
    streaming: {
      "": {
        label: "MS Teams Streaming",
        help: 'Microsoft Teams preview/progress streaming mode: "off" | "partial" | "block" | "progress". Personal chats use Teams native streaminfo progress when available.',
      },
    },
    progress: {
      labels: "openclaw",
      titleWording: true,
    },
  }),
} satisfies Record<string, ChannelConfigUiHint>;

const SecretInputSchema = buildSecretInputSchema();
const ToolPolicyBySenderSchema = z.record(z.string(), ToolPolicySchema).optional();

const MSTeamsChannelSchema = z
  .object({
    requireMention: z.boolean().optional(),
    requireMentionInBotThreads: z.boolean().optional(),
    tools: ToolPolicySchema,
    toolsBySender: ToolPolicyBySenderSchema,
    replyStyle: MSTeamsReplyStyleSchema.optional(),
  })
  .strict();

const MSTeamsTeamSchema = MSTeamsChannelSchema.extend({
  channels: z.record(z.string(), MSTeamsChannelSchema.optional()).optional(),
});

const { accountShape, rootPolicyShape } = buildChannelAccountSchemaParts({
  omit: ["name", "mentionPatterns", "replyToMode"],
  allowFrom: z.array(z.string()).optional(),
  groupAllowFrom: z.array(z.string()).optional(),
  streaming: ChannelPreviewStreamingConfigSchema.optional(),
});

const MSTeamsAccountConfigBaseSchema = z
  .object({
    ...accountShape,
    dangerouslyAllowNameMatching: ChannelDangerouslyAllowNameMatchingSchema,
    appId: z.string().optional(),
    appPassword: registerSensitiveConfigSchema(SecretInputSchema.optional()),
    tenantId: z.string().optional(),
    cloud: z.enum(["Public", "USGov", "USGovDoD", "China"]).optional(),
    serviceUrl: z
      .string()
      .url()
      .refine(isAllowedBotFrameworkServiceUrl, {
        message:
          "channels.msteams.serviceUrl must use a supported Microsoft Teams Bot Connector host",
      })
      .optional(),
    authType: z.enum(["secret", "federated"]).optional(),
    certificatePath: z.string().optional(),
    certificateThumbprint: z.string().optional(),
    useManagedIdentity: z.boolean().optional(),
    managedIdentityClientId: z.string().optional(),
    webhook: z
      .object({
        path: z.string().optional(),
      })
      .strict()
      .optional(),
    legacyWebhook: z
      .union([
        z.literal(false),
        z
          .object({
            port: z.number().int().min(1).max(65535),
            host: z.string().optional(),
          })
          .strict(),
      ])
      .optional(),
    typingIndicator: z.boolean().optional(),
    mediaAllowHosts: z.array(z.string()).optional(),
    mediaAuthAllowHosts: z.array(z.string()).optional(),
    graphMediaFallback: z.boolean().optional(),
    requireMention: z.boolean().optional(),
    requireMentionInBotThreads: z.boolean().optional(),
    replyStyle: MSTeamsReplyStyleSchema.optional(),
    teams: z.record(z.string(), MSTeamsTeamSchema.optional()).optional(),
    /** SharePoint site ID for file uploads in group chats/channels (e.g., "contoso.sharepoint.com,guid1,guid2") */
    sharePointSiteId: z.string().optional(),
    welcomeCard: z.boolean().optional(),
    promptStarters: z.array(z.string()).optional(),
    groupWelcomeCard: z.boolean().optional(),
    feedbackEnabled: z.boolean().optional(),
    feedbackReflection: z.boolean().optional(),
    feedbackReflectionCooldownMs: z.number().int().min(0).optional(),
    delegatedAuth: z
      .object({
        enabled: z.boolean().optional(),
        scopes: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    sso: z
      .object({
        enabled: z.boolean().optional(),
        connectionName: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const MSTeamsConfigSchema = MSTeamsAccountConfigBaseSchema.extend({
  ...rootPolicyShape,
  accounts: z
    .record(
      z.string(),
      MSTeamsAccountConfigBaseSchema.extend({ name: z.string().optional() }).optional(),
    )
    .optional(),
  defaultAccount: z.string().optional(),
})
  .strict()
  .superRefine(refineMSTeamsConfig);

export const MSTeamsChannelConfigSchema = buildChannelConfigSchema(MSTeamsConfigSchema, {
  uiHints: msTeamsChannelConfigUiHints,
});
