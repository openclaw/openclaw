import {
  buildChannelAccountSchemaParts,
  ChannelDangerouslyAllowNameMatchingSchema,
  ChannelPreviewStreamingConfigSchema,
  MSTeamsReplyStyleSchema,
  ToolPolicySchema,
} from "openclaw/plugin-sdk/channel-config-schema";
import {
  buildSecretInputSchema,
  registerSensitiveConfigSchema,
} from "openclaw/plugin-sdk/secret-input";
import { z } from "zod";

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

export const MSTeamsConfigSchemaBase = z
  .object({
    ...accountShape,
    ...rootPolicyShape,
    dangerouslyAllowNameMatching: ChannelDangerouslyAllowNameMatchingSchema,
    appId: z.string().optional(),
    appPassword: registerSensitiveConfigSchema(SecretInputSchema.optional()),
    tenantId: z.string().optional(),
    cloud: z.enum(["Public", "USGov", "USGovDoD", "China"]).optional(),
    serviceUrl: z.string().url().optional(),
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
