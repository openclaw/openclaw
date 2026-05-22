import { N as MessageReceipt } from "./types-BCEiUA0Y.js";
import { n as PollInput } from "./polls-FiOLh8s5.js";
import { n as NormalizedLocation } from "./location-CkjheH2l.js";
import { c as WAMessageKey, n as WhatsAppReplyContext, o as AnyMessageContent, r as WhatsAppSelfIdentity, s as MiscMessageGenerationOptions, t as WhatsAppIdentity } from "./identity-Cj4Vv3Qf.js";

//#region extensions/whatsapp/src/inbound/send-result.d.ts
type WhatsAppSendKind = "media" | "poll" | "reaction" | "text";
type WhatsAppSendKey = Omit<Pick<WAMessageKey, "fromMe" | "id" | "participant" | "remoteJid">, "id"> & {
  id: string;
};
type WhatsAppSendResult = {
  kind: WhatsAppSendKind;
  messageId: string;
  receipt?: MessageReceipt;
  keys: WhatsAppSendKey[];
  providerAccepted: boolean;
};
//#endregion
//#region extensions/whatsapp/src/inbound/types.d.ts
type WebListenerCloseReason = {
  status?: number;
  isLoggedOut: boolean;
  error?: unknown;
};
type ActiveWebSendOptions = {
  quotedMessageKey?: {
    id: string;
    remoteJid: string;
    fromMe: boolean;
    participant?: string;
    messageText?: string;
  };
  gifPlayback?: boolean;
  accountId?: string;
  fileName?: string;
};
type ActiveWebListener = {
  sendMessage: (to: string, text: string, mediaBuffer?: Buffer, mediaType?: string, options?: ActiveWebSendOptions) => Promise<WhatsAppSendResult>;
  sendPoll: (to: string, poll: PollInput) => Promise<WhatsAppSendResult>;
  sendReaction: (chatJid: string, messageId: string, emoji: string, fromMe: boolean, participant?: string) => Promise<WhatsAppSendResult>;
  sendComposingTo: (to: string) => Promise<void>;
  close?: () => Promise<void>;
};
type WhatsAppStructuredContactContext = {
  kind: "contact" | "contacts";
  total: number;
  contacts: Array<{
    name?: string;
    phones?: string[];
  }>;
};
type WebInboundMessage = {
  id?: string;
  from: string;
  conversationId: string;
  to: string;
  accountId: string; /** Set by the real inbound monitor after access-control / pairing checks pass. */
  accessControlPassed?: boolean;
  body: string;
  pushName?: string;
  timestamp?: number;
  chatType: "direct" | "group";
  chatId: string;
  sender?: WhatsAppIdentity;
  senderJid?: string;
  senderE164?: string;
  senderName?: string;
  replyTo?: WhatsAppReplyContext;
  replyToId?: string;
  replyToBody?: string;
  replyToSender?: string;
  replyToSenderJid?: string;
  replyToSenderE164?: string;
  groupSubject?: string;
  groupParticipants?: string[];
  mentions?: string[];
  mentionedJids?: string[];
  self?: WhatsAppSelfIdentity;
  selfJid?: string | null;
  selfLid?: string | null;
  selfE164?: string | null;
  fromMe?: boolean;
  location?: NormalizedLocation;
  sendComposing: () => Promise<void>;
  reply: (text: string, options?: MiscMessageGenerationOptions) => Promise<WhatsAppSendResult>;
  sendMedia: (payload: AnyMessageContent, options?: MiscMessageGenerationOptions) => Promise<WhatsAppSendResult>;
  mediaPath?: string;
  mediaType?: string;
  mediaFileName?: string;
  mediaUrl?: string;
  untrustedStructuredContext?: Array<{
    label: string;
    source?: string;
    type?: string;
    payload: unknown;
  }>;
  wasMentioned?: boolean;
  isBatched?: boolean;
};
//#endregion
export { WhatsAppStructuredContactContext as a, WebListenerCloseReason as i, ActiveWebSendOptions as n, WhatsAppSendResult as o, WebInboundMessage as r, ActiveWebListener as t };