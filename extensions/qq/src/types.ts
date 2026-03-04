/**
 * Types for QQ channel plugin.
 * @see https://bot.q.qq.com/wiki/
 */

export type QQDmPolicy = "open" | "pairing" | "allowlist";

export interface QQChannelConfig {
  enabled?: boolean;
  appId?: string;
  /** Bot Secret (clientSecret), for token and signature verification */
  clientSecret?: string;
  webhookPath?: string;
  rateLimitPerMinute?: number;
  dmPolicy?: QQDmPolicy;
  allowFrom?: string[] | number[];
  accounts?: Record<string, QQAccountRaw>;
}

export interface QQAccountRaw {
  enabled?: boolean;
  appId?: string;
  clientSecret?: string;
  webhookPath?: string;
  rateLimitPerMinute?: number;
  dmPolicy?: QQDmPolicy;
  allowFrom?: string[] | number[];
}

export interface ResolvedQQAccount {
  accountId: string;
  enabled: boolean;
  appId: string;
  clientSecret: string;
  webhookPath: string;
  rateLimitPerMinute: number;
  dmPolicy: QQDmPolicy;
  allowFrom: string[];
}

/** QQ callback payload: op=0 Dispatch, op=13 verify */
export interface QQCallbackPayload {
  op: number;
  d?: Record<string, unknown> & {
    plain_token?: string;
    event_ts?: string;
    id?: string;
    content?: string;
    msg_id?: string;
    author?: { id?: string; username?: string };
    channel_id?: string;
    guild_id?: string;
  };
  s?: number;
  t?: string;
}
