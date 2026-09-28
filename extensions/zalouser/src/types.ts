// Zalouser type declarations define plugin contracts.
import type {
  ChannelMessageSendTextContext,
  MessageReceipt,
} from "openclaw/plugin-sdk/channel-outbound";
import type { z } from "zod";
import type {
  ZalouserAccountSchema,
  ZalouserConfigSchema,
  ZalouserGroupConfigSchema,
} from "./config-schema.js";
import type { Style } from "./zca-constants.js";

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

export type ZaloEventMessage = {
  msgId: string;
  cliMsgId: string;
  uidFrom: string;
  idTo: string;
  msgType: string;
  st: number;
  at: number;
  cmd: number;
  ts: string | number;
};

export type ZaloInboundMessage = {
  threadId: string;
  isGroup: boolean;
  senderId: string;
  senderName?: string;
  groupName?: string;
  content: string;
  commandContent?: string;
  timestampMs: number;
  msgId?: string;
  cliMsgId?: string;
  hasAnyMention?: boolean;
  wasExplicitlyMentioned?: boolean;
  canResolveExplicitMention?: boolean;
  implicitMention?: boolean;
  quotedGlobalMsgId?: string;
  quotedOwnerId?: string;
  quotedBody?: string;
  eventMessage?: ZaloEventMessage;
  raw: unknown;
};

export type ZcaUserInfo = {
  userId: string;
  displayName: string;
  avatar?: string;
};

export type ZaloSendHandoff = Pick<
  ChannelMessageSendTextContext,
  "signal" | "assertDirectAdapterHandoff" | "onPlatformSendDispatch"
>;

export type ZaloSendOptions = ZaloSendHandoff & {
  mediaMaxBytes?: number;
  profile?: string;
  mediaUrl?: string;
  caption?: string;
  isGroup?: boolean;
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  textMode?: "markdown" | "plain";
  textChunkMode?: "length" | "newline";
  textChunkLimit?: number;
  textStyles?: Style[];
};

export type ZaloSendResult = {
  ok: boolean;
  messageId?: string;
  receipt: MessageReceipt;
  error?: string;
};

export type ZaloGroupContext = {
  groupId: string;
  name?: string;
  members?: string[];
};

export type ZaloAuthStatus = {
  connected: boolean;
  message: string;
};

export type ZalouserGroupConfig = z.input<typeof ZalouserGroupConfigSchema>;
export type ZalouserAccountConfig = z.input<typeof ZalouserAccountSchema>;
export type ZalouserConfig = z.input<typeof ZalouserConfigSchema>;

export type ResolvedZalouserAccount = {
  mediaMaxBytes?: number;
  accountId: string;
  name?: string;
  enabled: boolean;
  profile: string;
  authenticated: boolean;
  config: ZalouserAccountConfig;
};
