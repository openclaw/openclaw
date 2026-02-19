import { z } from "zod";
import { XmppAccountSchema, XmppConfigSchema } from "./config-schema.js";

export type XmppChatState = "active" | "inactive" | "gone" | "composing" | "paused";

export type XmppInboundMessage = {
  messageId: string;
  fromJid: string;
  toJid: string;
  body: string;
  isGroup: boolean;
  threadId?: string;
  chatState?: XmppChatState;
  receiptForId?: string;
  timestamp?: number;
  oobUrls?: string[];
};

export type XmppOutboundMessage = {
  toJid: string;
  body?: string;
  chatState?: XmppChatState;
  requestReceipt?: boolean;
};

export type XmppAccountConfig = z.infer<typeof XmppAccountSchema>;
export type CoreConfig = z.infer<typeof XmppConfigSchema>;
export type XmppTlsMode = "starttls" | "tls" | "none";
