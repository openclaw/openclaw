import { z } from "zod";

/**
 * Coalesce configuration for batching small messages before sending.
 */
export const CoalesceConfigSchema = z.object({
  enabled: z.boolean().default(true),
  minChars: z.number().min(200).default(800),
  maxChars: z.number().min(800).default(1200),
  idleMs: z.number().min(0).default(1000),
});

/**
 * Canonical channel id + plugin id (used for config compatibility).
 */
export const DINGTALK_CHANNEL_ID = "dingtalk";
export const DINGTALK_PLUGIN_ID = "dingtalk";
export const DINGTALK_NPM_PACKAGE = "@openclaw/dingtalk";

/**
 * Legacy id used by the initial external DingTalk plugin.
 * Keep reading legacy config keys for a smoother migration.
 */
export const DINGTALK_LEGACY_CHANNEL_ID = "clawdbot-dingtalk";

/**
 * DingTalk channel configuration schema.
 * Maps from YAML config under `channels.dingtalk.*`
 */
export const DingTalkConfigSchema = z.object({
  /** Enable/disable the channel */
  enabled: z.boolean().default(true),

  /** DingTalk app client ID (required) */
  clientId: z.string().optional(),

  /** DingTalk app client secret (required) */
  clientSecret: z.string().optional(),

  /** Path to file containing client secret */
  clientSecretFile: z.string().optional(),

  /** Display name for this account */
  name: z.string().optional(),

  /** DingTalk API base URL */
  apiBase: z.string().default("https://api.dingtalk.com"),

  /** Stream open path */
  openPath: z.string().default("/v1.0/gateway/connections/open"),

  /** Custom subscriptions JSON for stream */
  subscriptionsJson: z.string().optional(),

  /** Reply mode: text or markdown */
  replyMode: z.enum(["text", "markdown"]).default("text"),

  /** Maximum characters per message chunk */
  maxChars: z.number().min(200).max(8000).default(1800),

  /** Allowlist of sender IDs (empty = allow all) */
  allowFrom: z.array(z.string()).default([]),

  /** Bot's own user ID to skip self-messages */
  selfUserId: z.string().optional(),

  /** Require messages to start with this prefix (for group filtering) */
  requirePrefix: z.string().optional(),

  /** Require @机器人 in group chats (default: true) */
  requireMention: z.boolean().default(true),

  /** Isolate context per user in group chats (default: false) */
  isolateContextPerUserInGroup: z.boolean().default(false),

  /** Users who can bypass @mention requirement */
  mentionBypassUsers: z.array(z.string()).default([]),

  /** Prefix to add to response messages (supports {model}, {provider} vars) */
  responsePrefix: z.string().optional(),

  /** Table conversion mode for markdown */
  tableMode: z.enum(["code", "off"]).default("code"),

  /** Message coalescing configuration */
  coalesce: CoalesceConfigSchema.optional(),

  /** Show tool status messages (🔧 正在执行...) */
  showToolStatus: z.boolean().default(false),

  /** Show tool result messages (✅ ... 完成) */
  showToolResult: z.boolean().default(false),

  /** Thinking mode for Clawdbot */
  thinking: z.enum(["off", "minimal", "low", "medium", "high"]).default("off"),

  /** Multi-account configuration */
  accounts: z
    .record(
      z.string(),
      z.object({
        enabled: z.boolean().default(true),
        clientId: z.string().optional(),
        clientSecret: z.string().optional(),
        clientSecretFile: z.string().optional(),
        name: z.string().optional(),
        apiBase: z.string().optional(),
        openPath: z.string().optional(),
        subscriptionsJson: z.string().optional(),
        replyMode: z.enum(["text", "markdown"]).optional(),
        maxChars: z.number().min(200).max(8000).optional(),
        allowFrom: z.array(z.string()).optional(),
        selfUserId: z.string().optional(),
        requirePrefix: z.string().optional(),
        requireMention: z.boolean().optional(),
        isolateContextPerUserInGroup: z.boolean().optional(),
        mentionBypassUsers: z.array(z.string()).optional(),
        responsePrefix: z.string().optional(),
        tableMode: z.enum(["code", "off"]).optional(),
        coalesce: CoalesceConfigSchema.optional(),
        showToolStatus: z.boolean().optional(),
        showToolResult: z.boolean().optional(),
        thinking: z.enum(["off", "minimal", "low", "medium", "high"]).optional(),
      })
    )
    .optional(),
});

export type DingTalkConfig = z.infer<typeof DingTalkConfigSchema>;
export type CoalesceConfig = z.infer<typeof CoalesceConfigSchema>;

/**
 * Default values for coalesce config
 */
export const DEFAULT_COALESCE: CoalesceConfig = {
  enabled: true,
  minChars: 800,
  maxChars: 1200,
  idleMs: 1000,
};

/**
 * Default account ID when not using multi-account
 */
export const DEFAULT_ACCOUNT_ID = "default";
