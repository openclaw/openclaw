// Sms type declarations define plugin contracts.
import type { z } from "zod";
import type { SmsAccountConfigSchema, SmsConfigSchema } from "./config-schema.js";

type SmsAccountSchemaInput = z.input<typeof SmsAccountConfigSchema>;
type SmsChannelConfigFields = Omit<SmsAccountSchemaInput, "allowFrom"> & {
  /** Legacy scalar input normalized by the channel runtime. */
  allowFrom?: string | Array<string | number>;
};

export type SmsChannelConfig = Omit<z.input<typeof SmsConfigSchema>, "accounts" | "allowFrom"> &
  SmsChannelConfigFields & {
    accounts?: Record<string, SmsAccountRaw>;
    defaultAccount?: string;
  };

type SmsAccountRaw = SmsChannelConfigFields;

export interface ResolvedSmsAccount {
  accountId: string;
  enabled: boolean;
  accountSid: string;
  authToken: string;
  fromNumber: string;
  messagingServiceSid: string;
  defaultTo: string;
  webhookPath: string;
  publicWebhookUrl: string;
  dangerouslyDisableSignatureValidation: boolean;
  dmPolicy: "pairing" | "open" | "allowlist" | "disabled";
  allowFrom: string[];
  textChunkLimit: number;
  mediaMaxBytes?: number;
}

export interface SmsInboundMessage {
  messageSid: string;
  accountSid: string;
  messagingServiceSid?: string;
  from: string;
  to: string;
  body: string;
  media: SmsInboundMedia[];
  unavailableMediaCount?: number;
}

type SmsInboundMedia = {
  url: string;
  contentType?: string;
};

export type SmsSendResult = {
  sid: string;
  to: string;
  from?: string;
  status?: string;
};
