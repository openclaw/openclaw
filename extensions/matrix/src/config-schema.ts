import {
  AllowFromListSchema,
  buildChannelConfigSchema,
  buildGroupEntrySchema,
  buildNestedDmConfigSchema,
  ContextVisibilityModeSchema,
  GroupPolicySchema,
  MarkdownConfigSchema,
  MentionPatternsPolicySchema,
} from "openclaw/plugin-sdk/channel-config-schema";
import { buildSecretInputSchema } from "openclaw/plugin-sdk/secret-input";
import { z } from "zod";
import { matrixChannelConfigUiHints } from "./config-ui-hints.js";
import { matrixStreamingSchema, retiredMatrixStreamingMessage } from "./streaming-schema.js";

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

const botLoopProtectionSchema = z
  .object({
    enabled: z.boolean().optional(),
    maxEventsPerWindow: z.number().int().positive().optional(),
    windowSeconds: z.number().int().positive().optional(),
    cooldownSeconds: z.number().int().positive().optional(),
  })
  .strict()
  .optional();

export const matrixRoomSchema = buildGroupEntrySchema({
  requireMentionInBotThreads: z.boolean().optional(),
  account: z.string().optional(),
  allowBots: z.union([z.boolean(), z.literal("mentions")]).optional(),
  botLoopProtection: botLoopProtectionSchema,
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

const retiredMatrixAccountStreamingKeys = [
  "streamMode",
  "chunkMode",
  "blockStreaming",
  "blockStreamingCoalesce",
  "draftChunk",
] as const;

function hasNoRetiredMatrixAccountStreamingKeys(account: unknown): boolean {
  if (typeof account !== "object" || account === null || Array.isArray(account)) {
    return true;
  }
  return !retiredMatrixAccountStreamingKeys.some((key) => Object.hasOwn(account, key));
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
          streaming: matrixStreamingSchema.optional(),
        })
        .passthrough()
        .refine(hasNoRetiredMatrixAccountStreamingKeys, {
          message: retiredMatrixStreamingMessage,
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
  botLoopProtection: botLoopProtectionSchema,
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
