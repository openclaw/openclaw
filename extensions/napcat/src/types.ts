import type { DmPolicy, GroupPolicy } from "openclaw/plugin-sdk";

export type NapCatTransportHttpConfig = {
  enabled?: boolean;
  host?: string;
  port?: number;
  path?: string;
  bodyMaxBytes?: number;
};

export type NapCatTransportWsConfig = {
  enabled?: boolean;
  url?: string;
  reconnectMs?: number;
};

export type NapCatTransportConfig = {
  http?: NapCatTransportHttpConfig;
  ws?: NapCatTransportWsConfig;
};

export type NapCatGroupConfig = {
  enabled?: boolean;
  allow?: boolean;
  requireMention?: boolean;
  allowFrom?: Array<string | number>;
};

export type NapCatDmConfig = {
  enabled?: boolean;
  policy?: DmPolicy;
  allowFrom?: Array<string | number>;
};

export type NapCatConfig = {
  name?: string;
  enabled?: boolean;
  token?: string;
  apiBaseUrl?: string;
  defaultTo?: string;
  dm?: NapCatDmConfig;
  groupPolicy?: GroupPolicy;
  groupAllowFrom?: Array<string | number>;
  groups?: Record<string, NapCatGroupConfig>;
  transport?: NapCatTransportConfig;
  replyToMode?: "off" | "first" | "all";
  blockStreaming?: boolean;
  mediaMaxMb?: number;
};

export type ResolvedNapCatTransportHttpConfig = {
  enabled: boolean;
  host: string;
  port: number;
  path: string;
  bodyMaxBytes: number;
};

export type ResolvedNapCatTransportWsConfig = {
  enabled: boolean;
  url: string;
  reconnectMs: number;
};

export type ResolvedNapCatAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  configured: boolean;
  token?: string;
  tokenSource: "config" | "env" | "none";
  apiBaseUrl?: string;
  apiBaseUrlSource: "config" | "env" | "none";
  config: NapCatConfig;
  transport: {
    http: ResolvedNapCatTransportHttpConfig;
    ws: ResolvedNapCatTransportWsConfig;
  };
};

export type OneBotSegment = {
  type: string;
  data?: Record<string, unknown>;
};

export type OneBotMessageEvent = {
  post_type?: string;
  message_type?: "private" | "group" | string;
  sub_type?: string;
  message_id?: string | number;
  user_id?: string | number;
  group_id?: string | number;
  self_id?: string | number;
  time?: number;
  raw_message?: string;
  message?: OneBotSegment[] | string;
  sender?: {
    nickname?: string;
    card?: string;
    user_id?: string | number;
  };
  anonymous?: {
    name?: string;
  };
};

export type OneBotApiResponse<T = Record<string, unknown>> = {
  status?: string;
  retcode?: number;
  data?: T;
  msg?: string;
  wording?: string;
};

export type NapCatInboundMessage = {
  event: OneBotMessageEvent;
  messageId: string;
  senderId: string;
  senderName?: string;
  isGroup: boolean;
  targetId: string;
  rawBody: string;
  commandBody: string;
  mediaUrls: string[];
  selfId?: string;
  timestamp: number;
};
