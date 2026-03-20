/**
 * Type definitions for the WhatsApp Business channel plugin.
 *
 * Note: Meta API credentials (access token, phone number ID) are owned
 * by the hub, not the instance. The plugin sends outbound messages via the hub's
 * POST /api/whatsapp-business/send endpoint.
 */

type WhatsAppBusinessConfigFields = {
  enabled?: boolean;
  webhookPath?: string;
  dmPolicy?: "open" | "allowlist" | "disabled";
  allowedPhones?: string | string[];
};

/** Raw channel config from openclaw.json channels.whatsapp-business */
export interface WhatsAppBusinessChannelConfig extends WhatsAppBusinessConfigFields {
  accounts?: Record<string, WhatsAppBusinessAccountRaw>;
}

/** Raw per-account config (overrides base config) */
export interface WhatsAppBusinessAccountRaw extends WhatsAppBusinessConfigFields {}

/** Fully resolved account config with defaults applied */
export interface ResolvedWhatsAppBusinessAccount {
  accountId: string;
  enabled: boolean;
  webhookPath: string;
  dmPolicy: "open" | "allowlist" | "disabled";
  allowedPhones: string[];
}
