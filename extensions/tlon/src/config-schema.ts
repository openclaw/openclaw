// Tlon helper module supports config schema behavior.
import {
  ChannelImplicitMentionsSchema,
  buildChannelConfigSchema,
} from "openclaw/plugin-sdk/channel-config-schema";
import { createChannelConfigUiHints } from "openclaw/plugin-sdk/channel-core";
import { z } from "zod";

const ShipSchema = z.string().min(1);
const ChannelNestSchema = z.string().min(1);

const TlonChannelRuleSchema = z.object({
  mode: z.enum(["restricted", "open"]).optional(),
  allowedShips: z.array(ShipSchema).optional(),
  requireMentionInBotThreads: z.boolean().optional(),
});

const TlonAuthorizationSchema = z.object({
  channelRules: z.record(z.string(), TlonChannelRuleSchema).optional(),
});

const TlonNetworkSchema = z
  .object({
    dangerouslyAllowPrivateNetwork: z.boolean().optional(),
  })
  .strict()
  .optional();

const tlonCommonConfigFields = {
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  configWrites: z.boolean().optional(),
  mediaMaxMb: z.number().positive().optional(),
  ship: ShipSchema.optional(),
  url: z.string().optional(),
  code: z.string().optional(),
  network: TlonNetworkSchema,
  groupChannels: z.array(ChannelNestSchema).optional(),
  dmAllowlist: z.array(ShipSchema).optional(),
  groupInviteAllowlist: z.array(ShipSchema).optional(),
  autoDiscoverChannels: z.boolean().optional(),
  showModelSignature: z.boolean().optional(),
  responsePrefix: z.string().optional(),
  requireMentionInBotThreads: z.boolean().optional(),
  implicitMentions: ChannelImplicitMentionsSchema.optional(),
  // Auto-accept settings
  autoAcceptDmInvites: z.boolean().optional(), // Auto-accept DMs from ships in dmAllowlist
  autoAcceptGroupInvites: z.boolean().optional(), // Auto-accept all group invites
  // Owner ship for approval system
  ownerShip: ShipSchema.optional(), // Ship that receives approval requests and can approve/deny
} satisfies z.ZodRawShape;

const TlonAccountSchema = z.object({
  ...tlonCommonConfigFields,
});

export const TlonConfigSchema = z.object({
  ...tlonCommonConfigFields,
  historyLimit: z.number().int().min(0).optional(),
  authorization: TlonAuthorizationSchema.optional(),
  defaultAuthorizedShips: z.array(ShipSchema).optional(),
  accounts: z.record(z.string(), TlonAccountSchema).optional(),
});

const botThreadMentionHint = {
  label: "Require Mention in Bot Threads",
  help: "Override mention gating when this account's ship authored the thread root. False allows unmentioned replies; true requires a mention even after the bot participates. Omit to preserve existing behavior. Sender authorization still applies.",
};

export const tlonChannelConfigSchema = buildChannelConfigSchema(TlonConfigSchema, {
  uiHints: {
    ...createChannelConfigUiHints({
      channelLabel: "Tlon",
      implicitMentions: true,
    }),
    requireMentionInBotThreads: botThreadMentionHint,
    "accounts.*.requireMentionInBotThreads": botThreadMentionHint,
    "authorization.channelRules.*.requireMentionInBotThreads": botThreadMentionHint,
  },
});
