/**
 * Types for WeChat Official Account (微信公众号) channel.
 * @see https://developers.weixin.qq.com/doc/offiaccount/Message_Management/Receiving_standard_messages.html
 */

export type WeChatMPDmPolicy = "open" | "pairing" | "allowlist";

export interface WeChatMPChannelConfig {
  enabled?: boolean;
  appId?: string;
  appSecret?: string;
  token?: string;
  webhookPath?: string;
  rateLimitPerMinute?: number;
  dmPolicy?: WeChatMPDmPolicy;
  allowFrom?: string[] | number[];
  accounts?: Record<string, WeChatMPAccountRaw>;
}

export interface WeChatMPAccountRaw {
  enabled?: boolean;
  appId?: string;
  appSecret?: string;
  token?: string;
  webhookPath?: string;
  rateLimitPerMinute?: number;
  dmPolicy?: WeChatMPDmPolicy;
  allowFrom?: string[] | number[];
}

export interface ResolvedWeChatMPAccount {
  accountId: string;
  enabled: boolean;
  appId: string;
  appSecret: string;
  token: string;
  webhookPath: string;
  rateLimitPerMinute: number;
  dmPolicy: WeChatMPDmPolicy;
  allowFrom: string[];
}
