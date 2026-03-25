import type { AnyMessageContent, WAPresence, WASocket } from "@whiskeysockets/baileys";
import type { NormalizedLocation } from "openclaw/plugin-sdk/channel-inbound";
import type { ReconnectPolicy } from "../reconnect.js";

export type WebListenerCloseReason = {
  status?: number;
  isLoggedOut: boolean;
  error?: unknown;
};

export type WebSendSocket = Pick<WASocket, "sendMessage" | "sendPresenceUpdate"> & {
  sendMessage: (jid: string, content: AnyMessageContent) => Promise<unknown>;
  sendPresenceUpdate: (presence: WAPresence, jid?: string) => Promise<unknown>;
};

export type WebSocketRef = {
  current: WebSendSocket | null;
};

export type WebInboundMessage = {
  id?: string;
  from: string; // conversation id: E.164 for direct chats, group JID for groups
  conversationId: string; // alias for clarity (same as from)
  to: string;
  accountId: string;
  body: string;
  pushName?: string;
  timestamp?: number;
  chatType: "direct" | "group";
  chatId: string;
  senderJid?: string;
  senderE164?: string;
  senderName?: string;
  replyToId?: string;
  replyToBody?: string;
  replyToSender?: string;
  replyToSenderJid?: string;
  replyToSenderE164?: string;
  groupSubject?: string;
  groupParticipants?: string[];
  mentionedJids?: string[];
  selfJid?: string | null;
  selfE164?: string | null;
  fromMe?: boolean;
  location?: NormalizedLocation;
  sendComposing: () => Promise<void>;
  reply: (text: string) => Promise<void>;
  sendMedia: (payload: AnyMessageContent) => Promise<void>;
  shouldRetryDisconnect?: () => boolean;
  disconnectRetryWindowActive?: () => boolean;
  disconnectRetryPolicy?: ReconnectPolicy;
  disconnectRetryAbortSignal?: AbortSignal;
  disconnectRetryWakeSignal?: () => AbortSignal | undefined;
  mediaPath?: string;
  mediaType?: string;
  mediaFileName?: string;
  mediaUrl?: string;
  wasMentioned?: boolean;
};
