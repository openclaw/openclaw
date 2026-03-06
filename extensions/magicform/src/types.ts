/**
 * Type definitions for the MagicForm channel plugin.
 */

/** Raw channel config from openclaw.json channels.magicform */
export interface MagicFormChannelConfig {
  enabled?: boolean;
  backend_url?: string;
  api_token?: string;
  callback_path?: string;
  webhookPath?: string;
  dmPolicy?: "open" | "allowlist" | "disabled";
  allow_from?: string[];
  rateLimitPerMinute?: number;
  accounts?: Record<string, MagicFormAccountRaw>;
}

/** Raw per-account config (overrides base config) */
export interface MagicFormAccountRaw {
  enabled?: boolean;
  backend_url?: string;
  api_token?: string;
  callback_path?: string;
  webhookPath?: string;
  dmPolicy?: "open" | "allowlist" | "disabled";
  allow_from?: string[];
  rateLimitPerMinute?: number;
}

/** Fully resolved account config with defaults applied */
export interface ResolvedMagicFormAccount {
  accountId: string;
  enabled: boolean;
  backendUrl: string;
  apiToken: string;
  callbackPath: string;
  webhookPath: string;
  dmPolicy: "open" | "allowlist" | "disabled";
  allowFrom: string[];
  rateLimitPerMinute: number;
}

/** Inbound webhook payload (MagicForm → OpenClaw) */
export interface MagicFormWebhookPayload {
  message: string;
  stack_id: string;
  conversation_id: string;
  user_id: string;
  user_name?: string;
  workspace?: string;
  metadata?: Record<string, unknown>;
}

/** Outbound callback payload (OpenClaw → MagicForm) */
export interface MagicFormCallbackPayload {
  stack_id: string;
  conversation_id: string;
  user_id: string;
  response: string;
  status: "success" | "error";
  error?: string;
  metadata?: Record<string, unknown>;
}
