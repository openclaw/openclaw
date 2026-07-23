// Signal helper module supports config schema behavior.
import {
  buildChannelConfigSchema,
  buildChannelReactionShape,
  buildCommonChannelAccountShape,
  buildGroupEntrySchema,
  ChannelDeliveryStreamingConfigSchema,
  ChannelSendReadReceiptsSchema,
  ExecutableTokenSchema,
  ReplyToModeSchema,
  requireAllowlistAllowFrom,
  requireOpenAllowFrom,
} from "openclaw/plugin-sdk/channel-config-schema";
import { z } from "zod";
import { signalChannelConfigUiHints } from "./config-ui-hints.js";

const DirectGroupReplyToModeByChatTypeSchema = z
  .object({
    direct: ReplyToModeSchema.optional(),
    group: ReplyToModeSchema.optional(),
  })
  .strict();

const SignalGroupEntrySchema = buildGroupEntrySchema(
  {
    ingest: z.boolean().optional(),
  },
  { omit: ["skills", "enabled", "allowFrom", "systemPrompt"] },
);

const SignalGroupsSchema = z.record(z.string(), SignalGroupEntrySchema.optional()).optional();

const SignalAccountSchemaBase = z
  .object({
    ...buildCommonChannelAccountShape({
      useDefaults: true,
      omit: ["mentionPatterns"],
      streaming: ChannelDeliveryStreamingConfigSchema.optional(),
      mediaMaxMb: z.number().int().positive().optional(),
    }),
    account: z.string().optional(),
    accountUuid: z.string().optional(),
    configPath: z.string().optional(),
    httpUrl: z.string().optional(),
    cliPath: ExecutableTokenSchema.optional(),
    autoStart: z.boolean().optional(),
    startupTimeoutMs: z.number().int().min(1000).max(120000).optional(),
    receiveMode: z.union([z.literal("on-start"), z.literal("manual")]).optional(),
    ignoreAttachments: z.boolean().optional(),
    ignoreStories: z.boolean().optional(),
    sendReadReceipts: ChannelSendReadReceiptsSchema,
    aliases: z.record(z.string(), z.string()).optional(),
    groups: SignalGroupsSchema,
    replyToModeByChatType: DirectGroupReplyToModeByChatTypeSchema.optional(),
    ...buildChannelReactionShape({
      notificationModes: ["off", "own", "all", "allowlist"],
      reactionAllowlist: true,
      reactionLevels: ["off", "ack", "minimal", "extensive"],
    }),
    actions: z
      .object({
        reactions: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const SignalConfigSchema = SignalAccountSchemaBase.extend({
  apiMode: z.enum(["auto", "native", "container"]).optional(),
  // Account-level schemas skip allowFrom validation because accounts inherit
  // allowFrom from the parent channel config at runtime.
  accounts: z.record(z.string(), SignalAccountSchemaBase.optional()).optional(),
  defaultAccount: z.string().optional(),
}).superRefine((value, ctx) => {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message: 'channels.signal.dmPolicy="open" requires channels.signal.allowFrom to include "*"',
  });
  requireAllowlistAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message:
      'channels.signal.dmPolicy="allowlist" requires channels.signal.allowFrom to contain at least one sender ID',
  });

  for (const [accountId, account] of Object.entries(value.accounts ?? {})) {
    if (!account) {
      continue;
    }
    const effectivePolicy = account.dmPolicy ?? value.dmPolicy;
    const effectiveAllowFrom = account.allowFrom ?? value.allowFrom;
    requireOpenAllowFrom({
      policy: effectivePolicy,
      allowFrom: effectiveAllowFrom,
      ctx,
      path: ["accounts", accountId, "allowFrom"],
      message:
        'channels.signal.accounts.*.dmPolicy="open" requires channels.signal.accounts.*.allowFrom (or channels.signal.allowFrom) to include "*"',
    });
    requireAllowlistAllowFrom({
      policy: effectivePolicy,
      allowFrom: effectiveAllowFrom,
      ctx,
      path: ["accounts", accountId, "allowFrom"],
      message:
        'channels.signal.accounts.*.dmPolicy="allowlist" requires channels.signal.accounts.*.allowFrom (or channels.signal.allowFrom) to contain at least one sender ID',
    });
  }
});

export const SignalChannelConfigSchema = buildChannelConfigSchema(SignalConfigSchema, {
  uiHints: signalChannelConfigUiHints,
});
