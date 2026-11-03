import {
  ChannelGroupEntrySchema,
  DmPolicySchema,
  GroupPolicySchema,
  MarkdownConfigSchema,
  ReplyRuntimeConfigSchemaShape,
  ReplyToModeSchema,
  buildChannelConfigSchema,
  buildMultiAccountChannelSchema,
  requireOpenAllowFrom,
} from "openclaw/plugin-sdk/channel-config-schema";
import { createChannelConfigUiHints } from "openclaw/plugin-sdk/channel-core";
import type { ChannelConfigUiHint } from "openclaw/plugin-sdk/core";
import { z } from "zod";

const ircChannelConfigUiHints = {
  "": {
    label: "IRC",
    help: "IRC channel provider configuration and compatibility settings for classic IRC transport workflows. Use this section when bridging legacy chat infrastructure into OpenClaw.",
  },
  ...createChannelConfigUiHints({ channelLabel: "IRC", dmPolicy: { channelKey: "irc" } }),
  "nickserv.enabled": {
    label: "IRC NickServ Enabled",
    help: "Enable NickServ identify/register after connect (defaults to enabled when password is configured).",
  },
  "nickserv.service": {
    label: "IRC NickServ Service",
    help: "NickServ service nick (default: NickServ).",
  },
  "nickserv.password": {
    label: "IRC NickServ Password",
    help: "NickServ password used for IDENTIFY/REGISTER (sensitive).",
  },
  "nickserv.passwordFile": {
    label: "IRC NickServ Password File",
    help: "Optional file path containing NickServ password.",
  },
  "nickserv.register": {
    label: "IRC NickServ Register",
    help: "If true, send NickServ REGISTER on every connect. Use once for initial registration, then disable.",
  },
  "nickserv.registerEmail": {
    label: "IRC NickServ Register Email",
    help: "Email used with NickServ REGISTER (required when register=true).",
  },
  ...createChannelConfigUiHints({ channelLabel: "IRC", configWrites: true }),
} satisfies Record<string, ChannelConfigUiHint>;

const IrcNickServSchema = z
  .object({
    enabled: z.boolean().optional(),
    service: z.string().optional(),
    password: z.string().optional(),
    passwordFile: z.string().optional(),
    register: z.boolean().optional(),
    registerEmail: z.string().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.register && !value.registerEmail?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["registerEmail"],
        message: "channels.irc.nickserv.register=true requires channels.irc.nickserv.registerEmail",
      });
    }
  });

// Mirrors the core channel health-monitor leaf; the gateway supervisor reads
// channels.irc.healthMonitor.enabled for any started account.
const IrcHealthMonitorSchema = z
  .object({
    enabled: z.boolean().optional(),
  })
  .strict()
  .optional();

const IrcAccountSchemaBase = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    configWrites: z.boolean().optional(),
    healthMonitor: IrcHealthMonitorSchema,
    replyToMode: ReplyToModeSchema.optional(),
    dangerouslyAllowNameMatching: z.boolean().optional(),
    host: z.string().optional(),
    port: z.number().int().min(1).max(65535).optional(),
    tls: z.boolean().optional(),
    nick: z.string().optional(),
    username: z.string().optional(),
    realname: z.string().optional(),
    password: z.string().optional(),
    passwordFile: z.string().optional(),
    nickserv: IrcNickServSchema.optional(),
    dmPolicy: DmPolicySchema.optional().default("pairing"),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    groupPolicy: GroupPolicySchema.optional().default("allowlist"),
    groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    groups: z.record(z.string(), ChannelGroupEntrySchema.optional()).optional(),
    channels: z.array(z.string()).optional(),
    markdown: MarkdownConfigSchema,
    ...ReplyRuntimeConfigSchemaShape,
  })
  .strict();

export type IrcAccountConfigInput = z.input<typeof IrcAccountSchemaBase>;

const IrcConfigSchema = buildMultiAccountChannelSchema(IrcAccountSchemaBase, {
  optionalAccount: true,
  refine: (value, ctx) => {
    requireOpenAllowFrom({
      policy: value.dmPolicy,
      allowFrom: value.allowFrom,
      ctx,
      path: ["allowFrom"],
      message: 'channels.irc.dmPolicy="open" requires channels.irc.allowFrom to include "*"',
    });
  },
});

export const IrcChannelConfigSchema = buildChannelConfigSchema(IrcConfigSchema, {
  uiHints: ircChannelConfigUiHints,
});
