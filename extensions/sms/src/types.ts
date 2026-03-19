/**
 * Type definitions for the SMS channel plugin.
 *
 * Note: Quo API credentials (apiKey, phoneNumberId, fromNumber) are owned
 * by the hub, not the instance. The plugin sends outbound SMS via the hub's
 * POST /api/sms/send endpoint.
 */

type SmsConfigFields = {
  enabled?: boolean;
  webhookPath?: string;
  dmPolicy?: "open" | "allowlist" | "disabled";
  allowedPhones?: string | string[];
};

/** Raw channel config from openclaw.json channels.sms */
export interface SmsChannelConfig extends SmsConfigFields {
  accounts?: Record<string, SmsAccountRaw>;
}

/** Raw per-account config (overrides base config) */
export interface SmsAccountRaw extends SmsConfigFields {}

/** Fully resolved account config with defaults applied */
export interface ResolvedSmsAccount {
  accountId: string;
  enabled: boolean;
  webhookPath: string;
  dmPolicy: "open" | "allowlist" | "disabled";
  allowedPhones: string[];
}
