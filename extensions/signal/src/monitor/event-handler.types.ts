import type { HistoryEntry } from "../../../../src/auto-reply/reply/history.js";
import type { ReplyPayload } from "../../../../src/auto-reply/types.js";
import type { OpenClawConfig } from "../../../../src/config/config.js";
import type {
  DmPolicy,
  GroupPolicy,
  SignalReactionNotificationMode,
} from "../../../../src/config/types.js";
import type { RuntimeEnv } from "../../../../src/runtime.js";
import type { SignalSender } from "../identity.js";
import type { SignalReplyDeliveryState } from "./reply-delivery.js";

export type SignalEnvelope = {
  sourceNumber?: string | null;
  sourceUuid?: string | null;
  sourceName?: string | null;
  timestamp?: number | null;
  dataMessage?: SignalDataMessage | null;
  editMessage?: { dataMessage?: SignalDataMessage | null } | null;
  syncMessage?: unknown;
  reactionMessage?: SignalReactionMessage | null;
};

export type SignalMention = {
  name?: string | null;
  number?: string | null;
  uuid?: string | null;
  start?: number | null;
  length?: number | null;
};

export type SignalTextStyle = {
  start?: number | null;
  length?: number | null;
  style?: string | null;
};

export type SignalQuotedAttachment = {
  contentType?: string | null;
  filename?: string | null;
  thumbnail?: SignalAttachment | null;
};

export type SignalQuote = {
  id?: number | string | null; // signal-cli quote timestamp
  author?: string | null; // deprecated legacy identifier from signal-cli
  authorNumber?: string | null; // preferred E.164 author when available
  authorUuid?: string | null; // preferred UUID author when available
  text?: string | null;
  mentions?: Array<SignalMention | null> | null;
  attachments?: Array<SignalQuotedAttachment | null> | null;
  textStyles?: Array<SignalTextStyle | null> | null;
};

export type SignalReplyTarget = {
  id?: string; // message id of quoted message
  author?: string; // who wrote the quoted message
  body: string; // quoted text content
  kind: "quote"; // always quote for Signal
  mentions?: Array<SignalMention>; // mentions in quoted text
};

export type SignalDataMessage = {
  timestamp?: number;
  message?: string | null;
  attachments?: Array<SignalAttachment>;
  mentions?: Array<SignalMention> | null;
  groupInfo?: {
    groupId?: string | null;
    groupName?: string | null;
  } | null;
  quote?: SignalQuote | null;
  reaction?: SignalReactionMessage | null;
};

export type SignalReactionMessage = {
  emoji?: string | null;
  targetAuthor?: string | null;
  targetAuthorUuid?: string | null;
  targetSentTimestamp?: number | null;
  isRemove?: boolean | null;
  groupInfo?: {
    groupId?: string | null;
    groupName?: string | null;
  } | null;
};

export type SignalAttachment = {
  id?: string | null;
  contentType?: string | null;
  filename?: string | null;
  size?: number | null;
};

export type SignalReactionTarget = {
  kind: "phone" | "uuid";
  id: string;
  display: string;
};

export type SignalReceivePayload = {
  envelope?: SignalEnvelope | null;
  exception?: { message?: string } | null;
};

export type SignalEventHandlerDeps = {
  runtime: RuntimeEnv;
  cfg: OpenClawConfig;
  baseUrl: string;
  account?: string;
  accountUuid?: string;
  accountId: string;
  blockStreaming?: boolean;
  historyLimit: number;
  groupHistories: Map<string, HistoryEntry[]>;
  textLimit: number;
  dmPolicy: DmPolicy;
  allowFrom: string[];
  groupAllowFrom: string[];
  groupPolicy: GroupPolicy;
  reactionMode: SignalReactionNotificationMode;
  reactionAllowlist: string[];
  mediaMaxBytes: number;
  ignoreAttachments: boolean;
  sendReadReceipts: boolean;
  readReceiptsViaDaemon: boolean;
  fetchAttachment: (params: {
    baseUrl: string;
    account?: string;
    attachment: SignalAttachment;
    sender?: string;
    groupId?: string;
    maxBytes: number;
  }) => Promise<{ path: string; contentType?: string } | null>;
  deliverReplies: (params: {
    replies: ReplyPayload[];
    target: string;
    baseUrl: string;
    account?: string;
    accountId?: string;
    runtime: RuntimeEnv;
    maxBytes: number;
    textLimit: number;
    inheritedReplyToId?: string;
    replyDeliveryState?: SignalReplyDeliveryState;
    resolveQuoteAuthor?: (replyToId: string) => string | undefined;
  }) => Promise<void>;
  resolveSignalReactionTargets: (reaction: SignalReactionMessage) => SignalReactionTarget[];
  isSignalReactionMessage: (
    reaction: SignalReactionMessage | null | undefined,
  ) => reaction is SignalReactionMessage;
  shouldEmitSignalReactionNotification: (params: {
    mode?: SignalReactionNotificationMode;
    account?: string | null;
    targets?: SignalReactionTarget[];
    sender?: SignalSender | null;
    allowlist?: string[];
  }) => boolean;
  buildSignalReactionSystemEventText: (params: {
    emojiLabel: string;
    actorLabel: string;
    messageId: string;
    targetLabel?: string;
    groupLabel?: string;
  }) => string;
};
