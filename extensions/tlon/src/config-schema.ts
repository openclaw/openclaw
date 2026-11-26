import {
  ChannelImplicitMentionsSchema,
  buildChannelConfigSchema,
} from "openclaw/plugin-sdk/channel-config-schema";
import { createChannelConfigUiHints } from "openclaw/plugin-sdk/channel-core";
import { z } from "zod";
import { TLON_CLUB_ID_RE } from "./targets.js";

export const TlonClubPolicySchema = z.enum(["approve-once", "approve-each", "disabled"]);
export const TlonClubRulesSchema = z.record(
  z.string().regex(TLON_CLUB_ID_RE),
  z.enum(["allow", "deny"]),
);
export type TlonClubPolicy = z.infer<typeof TlonClubPolicySchema>;
export type TlonClubRules = z.infer<typeof TlonClubRulesSchema>;

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
  clubPolicy: TlonClubPolicySchema.optional(),
  clubRules: TlonClubRulesSchema.optional(),
  groupInviteAllowlist: z.array(ShipSchema).optional(),
  autoDiscoverChannels: z.boolean().optional(),
  crossChannelCitations: z.boolean().optional(),
  showModelSignature: z.boolean().optional(),
  responsePrefix: z.string().optional(),
  requireMentionInBotThreads: z.boolean().optional(),
  implicitMentions: ChannelImplicitMentionsSchema.optional(),
  autoAcceptDmInvites: z.boolean().optional(), // Auto-accept DMs from ships in dmAllowlist
  autoAcceptGroupInvites: z.boolean().optional(),
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

const crossChannelCitationsHint = {
  label: "Tlon Cross-Channel Citations",
  help: "Expand citations of posts from other channels into agent context. False expands only citations of the channel a message was posted in; the owner's 1:1 DMs are exempt. Default: true.",
};

const clubPolicyHint = {
  label: "Tlon Group DM Policy",
  help: "Default: approve-once. Enable each club once for automatic replies, require approval for every message with approve-each, or disable group DMs. Club authors and participants are unverified.",
};
const clubRulesHint = {
  label: "Tlon Group DM Rules",
  help: "Club IDs mapped to allow or deny. Allow accepts unverified input delivered under that club ID with the agent's normal permitted tools; it does not authenticate participants or grant owner authority. Deny blocks the club, not a claimed ship. Approve-each still requires each message; disabled overrides all rules.",
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
    clubPolicy: clubPolicyHint,
    "accounts.*.clubPolicy": clubPolicyHint,
    clubRules: clubRulesHint,
    "accounts.*.clubRules": clubRulesHint,
    crossChannelCitations: crossChannelCitationsHint,
    "accounts.*.crossChannelCitations": crossChannelCitationsHint,
  },
});
