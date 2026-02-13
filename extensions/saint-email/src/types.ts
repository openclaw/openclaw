import type { OpenClawConfig } from "openclaw/plugin-sdk";

export const SAINT_EMAIL_CHANNEL_ID = "email" as const;

export type SaintEmailAttachment = {
  filename: string;
  mimeType?: string;
  contentBase64: string;
};

export type SaintEmailOAuth2Config = {
  serviceAccountEmail?: string;
  privateKey?: string;
  subject?: string;
  tokenUri?: string;
  scopes?: string[];
};

export type SaintEmailChannelData = {
  subject?: string;
  cc?: string[];
  bcc?: string[];
  threadId?: string;
  references?: string;
  inReplyTo?: string;
  attachments?: SaintEmailAttachment[];
};

export type SaintEmailAccountConfig = {
  enabled?: boolean;
  name?: string;
  address?: string;
  userId?: string;
  accessToken?: string;
  oauth2?: SaintEmailOAuth2Config;
  dmPolicy?: "pairing" | "allowlist" | "open" | "disabled";
  allowFrom?: string[];
  pollIntervalSec?: number;
  pollQuery?: string;
  maxPollResults?: number;
  maxAttachmentMb?: number;
  pushVerificationToken?: string;
};

export type SaintEmailConfig = {
  enabled?: boolean;
  name?: string;
  address?: string;
  userId?: string;
  accessToken?: string;
  oauth2?: SaintEmailOAuth2Config;
  dmPolicy?: "pairing" | "allowlist" | "open" | "disabled";
  allowFrom?: string[];
  pollIntervalSec?: number;
  pollQuery?: string;
  maxPollResults?: number;
  maxAttachmentMb?: number;
  pushVerificationToken?: string;
  accounts?: Record<string, SaintEmailAccountConfig>;
};

export type ResolvedSaintEmailOAuth2Config = {
  serviceAccountEmail: string;
  privateKey: string;
  subject?: string;
  tokenUri: string;
  scopes: string[];
};

export type CoreConfig = OpenClawConfig & {
  channels?: OpenClawConfig["channels"] & {
    email?: SaintEmailConfig;
  };
};

export type ResolvedSaintEmailAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  address: string;
  userId: string;
  accessToken?: string;
  oauth2?: ResolvedSaintEmailOAuth2Config;
  dmPolicy: "pairing" | "allowlist" | "open" | "disabled";
  allowFrom: string[];
  pollIntervalSec: number;
  pollQuery: string;
  maxPollResults: number;
  maxAttachmentMb: number;
  pushVerificationToken?: string;
};

export type GmailMessageHeader = {
  name?: string;
  value?: string;
};

export type GmailMessagePart = {
  mimeType?: string;
  filename?: string;
  body?: {
    data?: string;
    size?: number;
    attachmentId?: string;
  };
  headers?: GmailMessageHeader[];
  parts?: GmailMessagePart[];
};

export type GmailMessage = {
  id: string;
  threadId?: string;
  internalDate?: string;
  payload?: GmailMessagePart;
  snippet?: string;
};

export type SaintEmailInboundMessage = {
  id: string;
  threadId?: string;
  subject: string;
  from: string;
  fromEmail: string;
  to: string;
  text: string;
  timestamp: number;
  attachments: Array<{
    path: string;
    filename: string;
    mimeType?: string;
  }>;
};
