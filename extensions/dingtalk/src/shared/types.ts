// 共享类型定义

export type DmPolicy = "open" | "pairing" | "allowlist";
export type GroupPolicy = "open" | "allowlist" | "disabled";

export interface ParsedMessage {
  chatId: string;
  messageId: string;
  senderId: string;
  senderName?: string;
  chatType: "direct" | "group";
  content: string;
  contentType: string;
  mentionedBot: boolean;
  replyToMessageId?: string;
  timestamp: number;
}

export interface HistoryEntry {
  sender: string;
  body: string;
  timestamp: number;
  messageId: string;
}
