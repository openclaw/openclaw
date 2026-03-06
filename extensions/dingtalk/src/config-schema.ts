import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { z } from "zod";
export { z };
import { buildSecretInputSchema, hasConfiguredSecretInput } from "./secret-input.js";

// DM 策略 / DM policy
const DmPolicySchema = z.enum(["open", "pairing", "allowlist"]);
// 群组策略 / Group policy
const GroupPolicySchema = z.enum(["open", "allowlist", "disabled"]);

// 群组会话范围 / Group session scope
const GroupSessionScopeSchema = z.enum(["group", "group_sender"]).optional();

// 群组配置 / Group configuration
export const DingtalkGroupSchema = z
  .object({
    requireMention: z.boolean().optional(),
    enabled: z.boolean().optional(),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    systemPrompt: z.string().optional(),
    groupSessionScope: GroupSessionScopeSchema,
  })
  .strict();

// AI Card 流式配置 / AI Card streaming configuration
const DingtalkStreamingSchema = z
  .object({
    enabled: z.boolean().optional(),
  })
  .strict()
  .optional();

// 共享配置字段（顶层和账号级别） / Shared config fields (top-level and per-account)
const DingtalkSharedConfigShape = {
  dmPolicy: DmPolicySchema.optional(),
  allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
  groupPolicy: GroupPolicySchema.optional(),
  groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
  requireMention: z.boolean().optional(),
  groups: z.record(z.string(), DingtalkGroupSchema.optional()).optional(),
  textChunkLimit: z.number().int().positive().optional(),
  chunkMode: z.enum(["length", "newline"]).optional(),
  mediaMaxMb: z.number().positive().optional(),
  groupSessionScope: GroupSessionScopeSchema,
  // 是否解析发送者名称 / Whether to resolve sender names
  resolveSenderNames: z.boolean().optional(),
  // AI Card 流式响应 / AI Card streaming responses
  streaming: DingtalkStreamingSchema,
};

// 单账号配置 / Per-account configuration
export const DingtalkAccountConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    // 账号显示名 / Display name for this account
    name: z.string().optional(),
    clientId: z.string().optional(),
    clientSecret: buildSecretInputSchema().optional(),
    // 机器人编码，通常等于 clientId / Robot code, usually same as clientId
    robotCode: z.string().optional(),
    ...DingtalkSharedConfigShape,
  })
  .strict();

// 顶层钉钉配置 / Top-level DingTalk configuration
export const DingtalkConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    defaultAccount: z.string().optional(),
    // 顶层凭证（单账号模式向后兼容） / Top-level credentials (backward compat for single-account)
    clientId: z.string().optional(),
    clientSecret: buildSecretInputSchema().optional(),
    robotCode: z.string().optional(),
    ...DingtalkSharedConfigShape,
    dmPolicy: DmPolicySchema.optional().default("pairing"),
    groupPolicy: GroupPolicySchema.optional().default("open"),
    requireMention: z.boolean().optional().default(true),
    resolveSenderNames: z.boolean().optional().default(true),
    // 多账号配置 / Multi-account configuration
    accounts: z.record(z.string(), DingtalkAccountConfigSchema.optional()).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    // 校验 defaultAccount 必须存在于 accounts 中 / Validate defaultAccount exists in accounts
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

    // 校验 dmPolicy="open" 需要 allowFrom 包含 "*" / Validate dmPolicy open requires wildcard
    if (value.dmPolicy === "open") {
      const allowFrom = value.allowFrom ?? [];
      const hasWildcard = allowFrom.some((entry) => String(entry).trim() === "*");
      if (!hasWildcard) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["allowFrom"],
          message:
            'channels.dingtalk.dmPolicy="open" requires channels.dingtalk.allowFrom to include "*"',
        });
      }
    }
  });
