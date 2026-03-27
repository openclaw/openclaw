import {
  ReplyRuntimeConfigSchemaShape,
  ToolPolicySchema,
} from "openclaw/plugin-sdk/agent-config-primitives";
import {
  BlockStreamingCoalesceSchema,
  DmConfigSchema,
  DmPolicySchema,
  GroupPolicySchema,
  MarkdownConfigSchema,
  requireOpenAllowFrom,
} from "openclaw/plugin-sdk/channel-config-primitives";
import { z } from "openclaw/plugin-sdk/zod";
import { buildSecretInputSchema } from "./secret-input.js";

function requireNextcloudTalkOpenAllowFrom(params: {
  policy?: string;
  allowFrom?: string[];
  ctx: z.RefinementCtx;
}) {
  requireOpenAllowFrom({
    policy: params.policy,
    allowFrom: params.allowFrom,
    ctx: params.ctx,
    path: ["allowFrom"],
    message:
      'channels.nextcloud-talk.dmPolicy="open" requires channels.nextcloud-talk.allowFrom to include "*"',
  });
}

export const NextcloudTalkRoomSchema = z
  .object({
    requireMention: z.boolean().optional(),
    tools: ToolPolicySchema,
    skills: z.array(z.string()).optional(),
    enabled: z.boolean().optional(),
    allowFrom: z.array(z.string()).optional(),
    systemPrompt: z.string().optional(),
  })
  .strict();

export const NextcloudTalkAccountSchemaBase = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    markdown: MarkdownConfigSchema,
    baseUrl: z.string().optional(),
    botSecret: buildSecretInputSchema().optional(),
    botSecretFile: z.string().optional(),
    apiUser: z.string().optional(),
    apiPassword: buildSecretInputSchema().optional(),
    apiPasswordFile: z.string().optional(),
    dmPolicy: DmPolicySchema.optional().default("pairing"),
    webhookPort: z.number().int().positive().optional(),
    webhookHost: z.string().optional(),
    webhookPath: z.string().optional(),
    webhookPublicUrl: z.string().optional(),
    allowFrom: z.array(z.string()).optional(),
    groupAllowFrom: z.array(z.string()).optional(),
    groupPolicy: GroupPolicySchema.optional().default("allowlist"),
    rooms: z.record(z.string(), NextcloudTalkRoomSchema.optional()).optional(),
    /** Allow fetching from private/internal IP addresses (e.g. localhost). Required for self-hosted Nextcloud on LAN/VPN. */
    allowPrivateNetwork: z.boolean().optional(),
    ...ReplyRuntimeConfigSchemaShape,
  })
  .strict();

export const NextcloudTalkAccountSchema = NextcloudTalkAccountSchemaBase.superRefine(
  (value, ctx) => {
    requireNextcloudTalkOpenAllowFrom({
      policy: value.dmPolicy,
      allowFrom: value.allowFrom,
      ctx,
    });
  },
);

export const NextcloudTalkConfigSchema = NextcloudTalkAccountSchemaBase.extend({
  accounts: z.record(z.string(), NextcloudTalkAccountSchema.optional()).optional(),
  defaultAccount: z.string().optional(),
}).superRefine((value, ctx) => {
  requireNextcloudTalkOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
  });
});
