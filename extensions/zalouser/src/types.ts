export type ZcaFriend = {
  userId: string;
  displayName: string;
  avatar?: string;
};

export type ZaloGroup = {
  groupId: string;
  name: string;
  memberCount?: number;
};

export type ZaloGroupMember = {
  userId: string;
  displayName: string;
  avatar?: string;
};

export type ZaloInboundMessage = {
  threadId: string;
  isGroup: boolean;
  senderId: string;
  senderName?: string;
  groupName?: string;
  content: string;
  timestampMs: number;
  msgId?: string;
  cliMsgId?: string;
  raw: unknown;
};

export type ZcaUserInfo = {
  userId: string;
  displayName: string;
  avatar?: string;
};

export type ZaloSendOptions = {
  profile?: string;
  mediaUrl?: string;
  caption?: string;
  isGroup?: boolean;
  mediaLocalRoots?: readonly string[];
};

export type ZaloSendResult = {
  ok: boolean;
  messageId?: string;
  error?: string;
};

export type ZaloAuthStatus = {
  connected: boolean;
  message: string;
};

type ZalouserToolConfig = { allow?: string[]; deny?: string[] };

type ZalouserGroupConfig = {
  allow?: boolean;
  enabled?: boolean;
  tools?: ZalouserToolConfig;
};

type ZalouserSharedConfig = {
  enabled?: boolean;
  name?: string;
  profile?: string;
  dmPolicy?: "pairing" | "allowlist" | "open" | "disabled";
  allowFrom?: Array<string | number>;
  groupPolicy?: "open" | "allowlist" | "disabled";
  groups?: Record<string, ZalouserGroupConfig>;
  messagePrefix?: string;
  responsePrefix?: string;
};

export type ZalouserAccountConfig = ZalouserSharedConfig;

export type ZalouserConfig = ZalouserSharedConfig & {
  defaultAccount?: string;
  accounts?: Record<string, ZalouserAccountConfig>;
};

export type ResolvedZalouserAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  profile: string;
  authenticated: boolean;
  config: ZalouserAccountConfig;
};
