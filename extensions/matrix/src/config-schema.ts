import {
  AllowFromListSchema,
  ChannelBotLoopProtectionSchema,
  ChannelDeliveryStreamingConfigSchema,
  ChannelStreamingPreviewSchema,
  ChannelStreamingProgressSchema,
  buildChannelConfigSchema,
  buildGroupEntrySchema,
  buildNestedDmConfigSchema,
  ContextVisibilityModeSchema,
  GroupPolicySchema,
  MarkdownConfigSchema,
  MentionPatternsPolicySchema,
} from "openclaw/plugin-sdk/channel-config-schema";
import { createChannelConfigUiHints } from "openclaw/plugin-sdk/channel-core";
import type { ChannelConfigUiHint } from "openclaw/plugin-sdk/channel-core";
import { buildSecretInputSchema } from "openclaw/plugin-sdk/secret-input";
import { z } from "zod";

const matrixChannelConfigUiHints = {
  requireMentionInBotThreads: {
    label: "Mention in Bot Threads",
    help: "Require a mention in threads rooted in this bot's own Matrix events. Set false to accept unmentioned follow-ups; omit to preserve the room's existing mention behavior.",
  },
  "rooms.*.requireMentionInBotThreads": {
    label: "Mention in Bot Threads",
    help: "Override the account's bot-created thread mention policy for this Matrix room. Exact room entries replace wildcard room settings.",
  },
  "groups.*.requireMentionInBotThreads": {
    label: "Mention in Bot Threads",
    help: "Override the account's bot-created thread mention policy for this Matrix room. Exact room entries replace wildcard room settings.",
  },
  joinIntro: {
    label: "Matrix Group Join Introduction",
    help: "Post one brief introduction when the bot joins an allowed group room (default: true). Account settings override the channel-wide setting.",
  },
  ...createChannelConfigUiHints({
    channelLabel: "Matrix",
    mentionPatterns: {
      targetDescription: "Matrix room IDs",
      policyNote:
        "Native Matrix mention evidence still triggers even when regex patterns are denied.",
      denyNote: "Native mention evidence still triggers.",
    },
  }),
  allowBots: {
    label: "Matrix Allow Bot Messages",
    help: 'Allow messages from other configured Matrix bot accounts to trigger replies (default: false). Set "mentions" to require a visible room mention.',
  },
  botLoopProtection: {
    label: "Matrix Bot Loop Protection",
    help: "Sliding-window guard for accepted Matrix configured-bot loops. Default is enabled whenever allowBots lets configured bot messages reach dispatch.",
  },
  "botLoopProtection.enabled": {
    label: "Matrix Bot Loop Protection Enabled",
    help: 'Enable the bot-pair loop guard. Defaults to true when allowBots is true or "mentions", and false when configured bot messages are ignored.',
  },
  "botLoopProtection.maxEventsPerWindow": {
    label: "Matrix Bot Loop Events per Window",
    help: "Maximum accepted bot-pair messages within the sliding window before suppression starts. Default: 20.",
  },
  "botLoopProtection.windowSeconds": {
    label: "Matrix Bot Loop Window Seconds",
    help: "Sliding window length for counting bot-pair messages. Default: 60.",
  },
  "botLoopProtection.cooldownSeconds": {
    label: "Matrix Bot Loop Cooldown Seconds",
    help: "How long to suppress the bot pair after it exceeds the budget. Default: 60.",
  },
  dangerouslyAllowNameMatching: {
    label: "Matrix Display Name Matching",
    help: "Compatibility opt-in for resolving Matrix display names and joined room names in allowlists. Prefer full @user:server IDs and room IDs or aliases because names are mutable.",
  },
  ...createChannelConfigUiHints({ channelLabel: "Matrix", progress: {} }),
} satisfies Record<string, ChannelConfigUiHint>;

const matrixActionSchema = z
  .object({
    reactions: z.boolean().optional(),
    messages: z.boolean().optional(),
    pins: z.boolean().optional(),
    profile: z.boolean().optional(),
    memberInfo: z.boolean().optional(),
    channelInfo: z.boolean().optional(),
    verification: z.boolean().optional(),
  })
  .optional();

const matrixThreadBindingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    idleHours: z.number().nonnegative().optional(),
    maxAgeHours: z.number().nonnegative().optional(),
    spawnSessions: z.boolean().optional(),
    defaultSpawnContext: z.enum(["isolated", "fork"]).optional(),
  })
  .optional();

const matrixExecApprovalsSchema = z
  .object({
    enabled: z.union([z.boolean(), z.literal("auto")]).optional(),
    approvers: AllowFromListSchema,
    agentFilter: z.array(z.string()).optional(),
    sessionFilter: z.array(z.string()).optional(),
    target: z.enum(["dm", "channel", "both"]).optional(),
  })
  .optional();

export const matrixRoomSchema = buildGroupEntrySchema({
  requireMentionInBotThreads: z.boolean().optional(),
  account: z.string().optional(),
  allowBots: z.union([z.boolean(), z.literal("mentions")]).optional(),
  botLoopProtection: ChannelBotLoopProtectionSchema.optional(),
  autoReply: z.boolean().optional(),
  users: AllowFromListSchema,
})
  .omit({ toolsBySender: true, allowFrom: true })
  .strict()
  .optional();

const matrixNetworkSchema = z
  .object({
    dangerouslyAllowPrivateNetwork: z.boolean().optional(),
  })
  .strict()
  .optional();

export const matrixStreamingSchema = z
  .object({
    mode: z.enum(["partial", "quiet", "progress", "off"]).optional(),
    ...ChannelDeliveryStreamingConfigSchema.shape,
    progress: ChannelStreamingProgressSchema.omit({ commentary: true, narration: true }).optional(),
    preview: ChannelStreamingPreviewSchema.pick({ toolProgress: true }).optional(),
  })
  .strict();

const retiredMatrixAccountStreamingKeys = [
  "streamMode",
  "chunkMode",
  "blockStreaming",
  "blockStreamingCoalesce",
  "draftChunk",
] as const;

function hasCanonicalMatrixAccountStreaming(account: unknown): boolean {
  if (typeof account !== "object" || account === null || Array.isArray(account)) {
    return true;
  }
  if (retiredMatrixAccountStreamingKeys.some((key) => Object.hasOwn(account, key))) {
    return false;
  }
  if (!Object.hasOwn(account, "streaming")) {
    return true;
  }
  const streaming = (account as { streaming?: unknown }).streaming;
  return typeof streaming === "object" && streaming !== null && !Array.isArray(streaming);
}

export const MatrixConfigSchema = z.object({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  configWrites: z.boolean().optional(),
  joinIntro: z.boolean().optional(),
  defaultAccount: z.string().optional(),
  // Accounts stay schema-open for most fields, but credential leaves must use
  // SecretInput so Control UI redaction keeps source/provider and only masks id.
  accounts: z
    .record(
      z.string(),
      z
        .object({
          joinIntro: z.boolean().optional(),
          requireMentionInBotThreads: z.boolean().optional(),
          accessToken: buildSecretInputSchema().optional(),
          password: buildSecretInputSchema().optional(),
        })
        .passthrough()
        .refine(hasCanonicalMatrixAccountStreaming, {
          message:
            'flat or scalar streaming values are no longer supported; use streaming.* and run "openclaw doctor --fix"',
        }),
    )
    .optional(),
  markdown: MarkdownConfigSchema,
  homeserver: z.string().optional(),
  network: matrixNetworkSchema,
  proxy: z.string().optional(),
  userId: z.string().optional(),
  accessToken: buildSecretInputSchema().optional(),
  password: buildSecretInputSchema().optional(),
  deviceId: z.string().optional(),
  deviceName: z.string().optional(),
  avatarUrl: z.string().optional(),
  initialSyncLimit: z.number().optional(),
  encryption: z.boolean().optional(),
  allowlistOnly: z.boolean().optional(),
  dangerouslyAllowNameMatching: z.boolean().optional(),
  allowBots: z.union([z.boolean(), z.literal("mentions")]).optional(),
  botLoopProtection: ChannelBotLoopProtectionSchema.optional(),
  groupPolicy: GroupPolicySchema.optional(),
  requireMentionInBotThreads: z.boolean().optional(),
  mentionPatterns: MentionPatternsPolicySchema.optional(),
  contextVisibility: ContextVisibilityModeSchema.optional(),
  streaming: matrixStreamingSchema.optional(),
  replyToMode: z.enum(["off", "first", "all", "batched"]).optional(),
  threadReplies: z.enum(["off", "inbound", "always"]).optional(),
  textChunkLimit: z.number().optional(),
  responsePrefix: z.string().optional(),
  ackReaction: z.string().optional(),
  ackReactionScope: z
    .enum(["group-mentions", "group-all", "direct", "all", "none", "off"])
    .optional(),
  reactionNotifications: z.enum(["off", "own"]).optional(),
  threadBindings: matrixThreadBindingsSchema,
  startupVerification: z.enum(["off", "if-unverified"]).optional(),
  startupVerificationCooldownHours: z.number().optional(),
  mediaMaxMb: z.number().optional(),
  historyLimit: z.number().int().min(0).optional(),
  autoJoin: z.enum(["always", "allowlist", "off"]).optional(),
  autoJoinAllowlist: AllowFromListSchema,
  groupAllowFrom: AllowFromListSchema,
  dm: buildNestedDmConfigSchema({
    sessionScope: z.enum(["per-user", "per-room"]).optional(),
    threadReplies: z.enum(["off", "inbound", "always"]).optional(),
  }),
  execApprovals: matrixExecApprovalsSchema,
  groups: z.object({}).catchall(matrixRoomSchema).optional(),
  rooms: z.object({}).catchall(matrixRoomSchema).optional(),
  actions: matrixActionSchema,
});

export const MatrixChannelConfigSchema = buildChannelConfigSchema(MatrixConfigSchema, {
  uiHints: matrixChannelConfigUiHints,
});
