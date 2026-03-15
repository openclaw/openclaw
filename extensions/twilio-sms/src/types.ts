import type { DmPolicy } from "openclaw/plugin-sdk/twilio-sms";

export type TwilioSmsAccountConfig = {
  name?: string;
  enabled?: boolean;
  accountSid?: string;
  authToken?: string;
  /** Twilio phone number in E.164 format (e.g. +15550001234). */
  phoneNumber?: string;
  /** Webhook path registered on the gateway (default: /twilio-sms/webhook). */
  webhookPath?: string;
  /** Public URL override for Twilio signature verification (useful behind proxies). */
  webhookUrl?: string;
  dmPolicy?: DmPolicy;
  allowFrom?: Array<string | number>;
  historyLimit?: number;
  textChunkLimit?: number;
  mediaMaxMb?: number;
  /** Enable daily PIN authentication to mitigate SMS sender spoofing. */
  pinAuth?: boolean;
  /** The PIN value (used when pinAuth is enabled). */
  pin?: string;
  /** Skip Twilio webhook signature validation (development only). */
  skipSignatureValidation?: boolean;
};

export type ResolvedTwilioSmsAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  config: TwilioSmsAccountConfig;
  /** True when accountSid, authToken, and phoneNumber are all present. */
  configured: boolean;
};

/** Parsed fields from a Twilio inbound SMS webhook POST body. */
export type TwilioSmsWebhookPayload = {
  messageSid: string;
  from: string;
  to: string;
  body: string;
  numMedia: number;
  mediaUrls: Array<{ url: string; contentType: string }>;
};
