export type LanxinConfig = {
  enabled?: boolean;
  name?: string;
  appId?: string;
  appSecret?: string | { source: "env" | "file" | "exec"; provider: string; id: string };
  aesKey?: string;
  apiBaseUrl?: string;
  webhookPath?: string;
  webhookHost?: string;
  webhookPort?: number;
  defaultEntryId?: string;
  debug?: boolean;
  dmPolicy?: "open" | "pairing" | "allowlist" | "disabled";
  allowFrom?: (string | number)[];
  groupPolicy?: "open" | "allowlist" | "disabled";
  groupAllowFrom?: (string | number)[];
};

export type ResolvedLanxinAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  name?: string;
  appId?: string;
  appSecret?: string;
  aesKey?: string;
  apiBaseUrl: string;
  config: LanxinConfig;
};

export type LanxinInboundEventEnvelope = {
  id?: string;
  type?: string;
  data?: Record<string, unknown>;
};

export type LanxinWebhookDecryptedPayload = {
  events?: LanxinInboundEventEnvelope[];
};

export type LanxinInboundMessage = {
  messageId: string;
  timestamp: number;
  isGroup: boolean;
  senderId: string;
  senderName?: string;
  userId: string;
  groupId?: string;
  entryId: string;
  text: string;
  msgType: string;
  mediaIds: string[];
};
