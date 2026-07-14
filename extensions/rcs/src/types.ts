// Rcs type declarations define plugin contracts.
import type { SecretInput } from "openclaw/plugin-sdk/secret-input";

export type RcsTransport = "rcs-only" | "rcs-preferred";

type RcsChannelConfigFields = {
  enabled?: boolean;
  accountSid?: string;
  authToken?: SecretInput;
  messagingServiceSid?: string;
  senderId?: string;
  transport?: RcsTransport;
  defaultTo?: string;
  webhookPath?: string;
  publicWebhookUrl?: string;
  sharedWebhookPath?: string;
  sharedWebhookPublicUrl?: string;
  smsForwardWebhookPath?: string;
  statusCallbacks?: boolean;
  dangerouslyDisableSignatureValidation?: boolean;
  dmPolicy?: "pairing" | "open" | "allowlist" | "disabled";
  allowFrom?: string | Array<string | number>;
  textChunkLimit?: number;
};

export interface RcsChannelConfig extends RcsChannelConfigFields {
  accounts?: Record<string, RcsAccountRaw>;
  defaultAccount?: string;
}

interface RcsAccountRaw extends RcsChannelConfigFields {}

export interface ResolvedRcsAccount {
  accountId: string;
  enabled: boolean;
  accountSid: string;
  authToken: string;
  messagingServiceSid: string;
  senderId: string;
  transport: RcsTransport;
  defaultTo: string;
  webhookPath: string;
  publicWebhookUrl: string;
  sharedWebhookPath: string;
  sharedWebhookPublicUrl: string;
  smsForwardWebhookPath: string;
  statusCallbacks: boolean;
  dangerouslyDisableSignatureValidation: boolean;
  dmPolicy: "pairing" | "open" | "allowlist" | "disabled";
  allowFrom: string[];
  textChunkLimit: number;
}

export interface RcsInboundMessage {
  messageSid: string;
  accountSid: string;
  /** Raw Twilio From value; `rcs:+E164` for RCS, `+E164` for SMS fallback. */
  from: string;
  to: string;
  body: string;
  mediaUrls: string[];
  buttonPayload?: string;
  /** True when the inbound message arrived over the RCS transport. */
  viaRcs: boolean;
}

export interface RcsStatusEvent {
  messageSid: string;
  status: string;
  to: string;
  errorCode?: string;
  timestamp: number;
}

export type RcsSendResult = {
  sid: string;
  to: string;
  from?: string;
  status?: string;
};
