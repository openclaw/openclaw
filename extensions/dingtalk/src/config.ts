// DingTalk config schema
import { z } from "zod";

/**
 * Async task mode configuration (simplified)
 */
export const AsyncTaskModeConfigSchema = z.object({
  /** Whether to enable async task mode */
  enabled: z.boolean().optional().default(false),
  /** Maximum concurrency (per user) */
  maxConcurrency: z.number().int().min(1).max(10).optional().default(3),
  /** Task timeout (milliseconds) */
  taskTimeoutMs: z.number().int().min(10000).optional().default(300000),
  /** Async task trigger words list (overrides default config) */
  asyncTriggerWords: z.array(z.string()).optional().default([]),
});

export type AsyncTaskModeConfig = z.infer<typeof AsyncTaskModeConfigSchema>;

/**
 * DingTalk channel config Schema
 *
 * Config field descriptions:
 * - enabled: Whether to enable this channel
 * - clientId: DingTalk application AppKey
 * - clientSecret: DingTalk application AppSecret
 * - dmPolicy: DM policy (open=open, pairing=pairing, allowlist=allowlist)
 * - groupPolicy: Group policy (open=open, allowlist=allowlist, disabled=disabled)
 * - requireMention: Whether group chat requires @bot to respond
 * - allowFrom: DM allowlist user ID list
 * - groupAllowFrom: Group chat allowlist conversation ID list
 * - historyLimit: History message count limit
 * - textChunkLimit: Text chunk size limit
 * - enableAICard: Whether to enable AI Card streaming response
 * - maxFileSizeMB: Media file size limit (MB)
 * - replyFinalOnly: Whether to only send final reply (non-streaming)
 * - asyncMode: Async task mode configuration
 */
export const DingtalkConfigSchema = z.object({
  /** Whether to enable DingTalk channel */
  enabled: z.boolean().optional().default(true),

  /** DingTalk application AppKey (clientId) */
  clientId: z.string().optional(),

  /** DingTalk application AppSecret (clientSecret) */
  clientSecret: z.string().optional(),

  /** DM policy: open=open, pairing=pairing, allowlist=allowlist */
  dmPolicy: z.enum(["open", "pairing", "allowlist"]).optional().default("open"),

  /** Group policy: open=open, allowlist=allowlist, disabled=disabled */
  groupPolicy: z.enum(["open", "allowlist", "disabled"]).optional().default("open"),

  /** Whether group chat requires @bot to respond */
  requireMention: z.boolean().optional().default(true),

  /** DM allowlist: allowed user ID list */
  allowFrom: z.array(z.string()).optional(),

  /** Group chat allowlist: allowed conversation ID list */
  groupAllowFrom: z.array(z.string()).optional(),

  /** History message count limit */
  historyLimit: z.number().int().min(0).optional().default(10),

  /** Text chunk size limit (DingTalk single message max 4000 chars) */
  textChunkLimit: z.number().int().positive().optional().default(4000),

  /** Whether to enable AI Card streaming response */
  enableAICard: z.boolean().optional().default(true),

  /** Gateway auth token (Bearer) */
  gatewayToken: z.string().optional(),

  /** Gateway auth password (alternative to gatewayToken) */
  gatewayPassword: z.string().optional(),

  /** Media file size limit (MB), default 100MB */
  maxFileSizeMB: z.number().positive().optional().default(100),

  /** Only send final reply (non-streaming). Default false, enable AI Card streaming update */
  replyFinalOnly: z.boolean().optional().default(false),

  /** Default operator DingTalk unionId (for Agent Tool auto-fill user_id) */
  operatorUserId: z.string().optional(),

  /** Async task mode configuration */
  asyncMode: AsyncTaskModeConfigSchema.optional(),

  /** Multi-account configuration (keyed by account ID) */
  accounts: z.record(z.string(), z.any()).optional(),

  /** Jarvis persona configuration */
  persona: z
    .object({
      /** Whether to enable personalized persona (default true) */
      enabled: z.boolean().optional().default(true),
      /** Honorific for user (default "Sir") */
      honorific: z.string().optional().default("Sir"),
      /** Tone style: formal=formal, casual=casual, jarvis=classic jarvis */
      tone: z.enum(["formal", "casual", "jarvis"]).optional().default("jarvis"),
      /** Custom greeting prefix (overrides default time-based greeting) */
      customGreeting: z.string().optional(),
    })
    .optional(),
});

export type DingtalkConfig = z.infer<typeof DingtalkConfigSchema>;

/**
 * Check if DingTalk config has credentials configured
 * @param config DingTalk config object
 * @returns Whether clientId and clientSecret are configured
 */
export function isConfigured(config: DingtalkConfig | undefined): boolean {
  return Boolean(config?.clientId && config?.clientSecret);
}

/**
 * Resolve DingTalk credentials
 * @param config DingTalk config object
 * @returns Credentials object or undefined
 */
export function resolveDingtalkCredentials(
  config: DingtalkConfig | undefined,
): { clientId: string; clientSecret: string } | undefined {
  if (!config?.clientId || !config?.clientSecret) {
    return undefined;
  }
  return {
    clientId: config.clientId,
    clientSecret: config.clientSecret,
  };
}
