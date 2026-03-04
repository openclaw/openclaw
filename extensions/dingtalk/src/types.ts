/**
 * Types for DingTalk (钉钉) channel plugin.
 * @see https://open.dingtalk.com/document/dingstart/receive-message
 */

export type DingTalkDmPolicy = "open" | "pairing" | "allowlist";

/** Raw channel config from openclaw.json channels.dingtalk */
export interface DingTalkChannelConfig {
  enabled?: boolean;
  /** 应用 Key (ClientID)，与 appSecret 一起用于 access_token 或可选签名校验 */
  appKey?: string;
  /** 应用 Secret，用于签名验证与 access_token */
  appSecret?: string;
  /** 企业 ID，新版 token 接口需要 */
  corpId?: string;
  /** 机器人接收消息的 HTTP 路径，如 /webhook/dingtalk */
  webhookPath?: string;
  /** 限流：每分钟每用户最大请求数 */
  rateLimitPerMinute?: number;
  dmPolicy?: DingTalkDmPolicy;
  allowFrom?: string[] | number[];
  /** 多账号 */
  accounts?: Record<string, DingTalkAccountRaw>;
}

export interface DingTalkAccountRaw {
  enabled?: boolean;
  appKey?: string;
  appSecret?: string;
  corpId?: string;
  webhookPath?: string;
  rateLimitPerMinute?: number;
  dmPolicy?: DingTalkDmPolicy;
  allowFrom?: string[] | number[];
}

/** Fully resolved account with defaults */
export interface ResolvedDingTalkAccount {
  accountId: string;
  enabled: boolean;
  appKey: string;
  appSecret: string;
  corpId: string;
  webhookPath: string;
  rateLimitPerMinute: number;
  dmPolicy: DingTalkDmPolicy;
  allowFrom: string[];
}

/** 钉钉机器人回调请求体（接收消息） */
export interface DingTalkInboundPayload {
  msgtype?: string;
  text?: { content?: string };
  msgId?: string;
  createAt?: number;
  conversationType?: string;
  conversationId?: string;
  senderId?: string;
  senderNick?: string;
  senderStaffId?: string;
  sessionWebhook?: string;
  sessionWebhookExpiredTime?: number;
  conversationTitle?: string;
  atUsers?: unknown[];
}
