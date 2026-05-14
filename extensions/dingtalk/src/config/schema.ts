import { z } from "zod";
import { normalizeAccountId } from "../sdk/helpers.ts";
export { z };
import { buildSecretInputSchema, hasConfiguredSecretInput } from "../secret-input.ts";

const DmPolicySchema = z.enum(["open", "pairing", "allowlist"]);
const GroupPolicySchema = z.enum(["open", "allowlist", "disabled"]);

const ToolPolicySchema = z
  .object({
    allow: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional(),
  })
  .strict()
  .optional();

/**
 * Group session scope for routing DingTalk group messages.
 * - "group" (default): one session per group chat
 * - "group_sender": one session per (group + sender)
 */
const GroupSessionScopeSchema = z.enum(["group", "group_sender"]).optional();

/**
 * Group reply mode for DingTalk group messages.
 * - "text": use plain text reply
 * - "markdown" (default): use markdown reply
 */
const GroupReplyModeSchema = z.enum(["text", "markdown"]).optional();

/**
 * Dingtalk tools configuration.
 * Controls which tool categories are enabled.
 */
const DingtalkToolsConfigSchema = z
  .object({
    docs: z.boolean().optional(), // Document operations (default: true)
    media: z.boolean().optional(), // Media upload operations (default: true)
  })
  .strict()
  .optional();

export const DingtalkGroupSchema = z
  .object({
    requireMention: z.boolean().optional(),
    tools: ToolPolicySchema,
    enabled: z.boolean().optional(),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    systemPrompt: z.string().optional(),
    groupSessionScope: GroupSessionScopeSchema,
  })
  .strict();

const DingtalkSharedConfigShape = {
  dmPolicy: DmPolicySchema.optional(),
  allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
  groupPolicy: GroupPolicySchema.optional(),
  groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
  requireMention: z.boolean().optional(),
  groups: z.record(z.string(), DingtalkGroupSchema.optional()).optional(),
  historyLimit: z.number().int().min(0).optional(),
  textChunkLimit: z.number().int().positive().optional(),
  mediaMaxMb: z.number().positive().optional(),
  tools: DingtalkToolsConfigSchema,
  typingIndicator: z.boolean().optional(),
  resolveSenderNames: z.boolean().optional(),
  separateSessionByConversation: z.boolean().optional(),
  sharedMemoryAcrossConversations: z.boolean().optional(),
  groupSessionScope: GroupSessionScopeSchema,
  asyncMode: z.boolean().optional(),
  ackText: z.string().optional(),
  endpoint: z.string().optional(), // DWClient gateway endpoint
  debug: z.boolean().optional(), // DWClient debug mode
  enableMediaUpload: z.boolean().optional(),
  systemPrompt: z.string().optional(),
  groupReplyMode: GroupReplyModeSchema,
};

/**
 * Per-account configuration.
 * All fields are optional - missing fields inherit from top-level config.
 */
export const DingtalkAccountConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    name: z.string().optional(), // Display name for this account
    clientId: z.union([z.string(), z.number()]).optional(),
    clientSecret: buildSecretInputSchema().optional(),
    /**
     * Encrypted DingTalk identity of this bot, used by other agents to @-mention
     * this bot in group messages. Fill from log line `[BotIdentity] chatbotUserId=...`
     * after the bot has received at least one group/DM message.
     */
    chatbotUserId: z.string().optional(),
    chatbotCorpId: z.string().optional(),
    ...DingtalkSharedConfigShape,
  })
  .strict();

/**
 * Base schema (ZodObject) without superRefine, used for JSON Schema generation (Web UI).
 * superRefine turns the schema into ZodEffects which is not compatible with buildChannelConfigSchema.
 */
export const DingtalkConfigBaseSchema = z
  .object({
    enabled: z.boolean().optional(),
    defaultAccount: z.string().optional(),
    // Top-level credentials (backward compatible for single-account mode)
    clientId: z.union([z.string(), z.number()]).optional(),
    clientSecret: buildSecretInputSchema().optional(),
    ...DingtalkSharedConfigShape,
    dmPolicy: DmPolicySchema.optional().default("open"),
    groupPolicy: GroupPolicySchema.optional().default("open"),
    requireMention: z.boolean().optional().default(true),
    separateSessionByConversation: z.boolean().optional().default(true),
    sharedMemoryAcrossConversations: z.boolean().optional().default(false),
    groupSessionScope: GroupSessionScopeSchema.optional().default("group"),
    // Multi-account configuration
    accounts: z.record(z.string(), DingtalkAccountConfigSchema.optional()).optional(),
  })
  .strict();

export const DingtalkConfigSchema = DingtalkConfigBaseSchema.superRefine((value, ctx) => {
  const defaultAccount = value.defaultAccount?.trim();
  if (defaultAccount && value.accounts && Object.keys(value.accounts).length > 0) {
    const normalizedDefaultAccount = normalizeAccountId(defaultAccount);
    if (!Object.prototype.hasOwnProperty.call(value.accounts, normalizedDefaultAccount)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["defaultAccount"],
        message: `channels.dingtalk.defaultAccount="${defaultAccount}" does not match a configured account key`,
      });
    }
  }

  // Validate dmPolicy and allowFrom consistency
  if (value.dmPolicy === "allowlist") {
    const allowFrom = value.allowFrom ?? [];
    if (allowFrom.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["allowFrom"],
        message:
          'channels.dingtalk.dmPolicy="allowlist" requires channels.dingtalk.allowFrom to contain at least one entry',
      });
    }
  }

  // Validate groupPolicy and groupAllowFrom consistency
  if (value.groupPolicy === "allowlist") {
    const groupAllowFrom = value.groupAllowFrom ?? [];
    if (groupAllowFrom.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["groupAllowFrom"],
        message:
          'channels.dingtalk.groupPolicy="allowlist" requires channels.dingtalk.groupAllowFrom to contain at least one entry',
      });
    }
  }
});
