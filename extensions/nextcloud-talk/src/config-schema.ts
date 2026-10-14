import {
  DmPolicySchema,
  GroupPolicySchema,
  MarkdownConfigSchema,
  ReplyRuntimeConfigSchemaShape,
  ReplyToModeSchema,
  buildGroupEntrySchema,
  buildMultiAccountChannelSchema,
  requireOpenAllowFrom,
} from "openclaw/plugin-sdk/channel-config-schema";
import { requireChannelOpenAllowFrom } from "openclaw/plugin-sdk/extension-shared";
import { buildSecretInputSchema } from "openclaw/plugin-sdk/secret-input";
import { z } from "zod";

export const NextcloudTalkRoomSchema = buildGroupEntrySchema({
  allowFrom: z.array(z.string()).optional(),
}).omit({ toolsBySender: true });

const NextcloudTalkNetworkSchema = z
  .object({
    /** Dangerous opt-in for self-hosted Nextcloud Talk on trusted private/internal hosts. */
    dangerouslyAllowPrivateNetwork: z.boolean().optional(),
  })
  .strict()
  .optional();

export const NextcloudTalkAccountSchemaBase = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    configWrites: z.boolean().optional(),
    replyToMode: ReplyToModeSchema.optional(),
    markdown: MarkdownConfigSchema,
    baseUrl: z.string().optional(),
    botSecret: buildSecretInputSchema().optional(),
    botSecretFile: z.string().optional(),
    apiUser: z.string().optional(),
    apiPassword: buildSecretInputSchema().optional(),
    apiPasswordFile: z.string().optional(),
    dmPolicy: DmPolicySchema.optional().default("pairing"),
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
    webhookPath: z.string().optional(),
    webhookPublicUrl: z.string().optional(),
    allowFrom: z.array(z.string()).optional(),
    groupAllowFrom: z.array(z.string()).optional(),
    groupPolicy: GroupPolicySchema.optional().default("allowlist"),
    rooms: z.record(z.string(), NextcloudTalkRoomSchema.optional()).optional(),
    /** Network policy overrides for self-hosted Nextcloud Talk on trusted private/internal hosts. */
    network: NextcloudTalkNetworkSchema,
    ...ReplyRuntimeConfigSchemaShape,
  })
  .strict();

export const NextcloudTalkConfigSchema = buildMultiAccountChannelSchema(
  NextcloudTalkAccountSchemaBase,
  {
    optionalAccount: true,
    refine: (value, ctx) => {
      requireChannelOpenAllowFrom({
        channel: "nextcloud-talk",
        policy: value.dmPolicy,
        allowFrom: value.allowFrom,
        ctx,
        requireOpenAllowFrom,
      });
    },
  },
);
