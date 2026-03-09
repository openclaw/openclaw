/**
 * Type definitions for the InboxAPI email channel plugin.
 */

/** Raw channel config from openclaw.json channels.inboxapi */
export interface InboxApiChannelConfig {
  enabled?: boolean;
  mcpEndpoint?: string;
  credentialsPath?: string;
  accessToken?: string;
  domain?: string;
  fromName?: string;
  pollIntervalMs?: number;
  pollBatchSize?: number;
  dmPolicy?: "open" | "allowlist" | "pairing" | "disabled";
  allowFrom?: string | string[];
  textChunkLimit?: number;
  accounts?: Record<string, InboxApiAccountRaw>;
}

/** Raw per-account config (overrides base config) */
export interface InboxApiAccountRaw {
  enabled?: boolean;
  mcpEndpoint?: string;
  credentialsPath?: string;
  accessToken?: string;
  domain?: string;
  fromName?: string;
  pollIntervalMs?: number;
  pollBatchSize?: number;
  dmPolicy?: "open" | "allowlist" | "pairing" | "disabled";
  allowFrom?: string | string[];
  textChunkLimit?: number;
}

/** Fully resolved account config with defaults applied */
export interface ResolvedInboxApiAccount {
  accountId: string;
  enabled: boolean;
  mcpEndpoint: string;
  credentialsPath: string;
  accessToken: string;
  domain: string;
  fromName: string;
  pollIntervalMs: number;
  pollBatchSize: number;
  dmPolicy: "open" | "allowlist" | "pairing" | "disabled";
  allowFrom: string[];
  textChunkLimit: number;
}

/** Credentials file format (~/.local/inboxapi/credentials.json) */
export interface InboxApiCredentials {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  domain?: string;
  accountName?: string;
}

/** Email object returned by InboxAPI */
export interface InboxApiEmail {
  id: string;
  messageId: string;
  from: string;
  fromName?: string;
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
  date: string;
  inReplyTo?: string;
  references?: string[];
  attachments?: InboxApiAttachment[];
}

/** Email attachment */
export interface InboxApiAttachment {
  filename: string;
  contentType: string;
  size: number;
  content?: string; // base64
}

/** WhoAmI response */
export interface InboxApiWhoAmI {
  accountName: string;
  email: string;
  domain: string;
}
