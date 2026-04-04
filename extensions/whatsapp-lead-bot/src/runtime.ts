/**
 * Runtime interface - contract for sending messages and managing WhatsApp labels.
 */

export interface Runtime {
  sendMessage(
    to: string,
    content: { text: string; metadata?: Record<string, unknown> },
    options?: { accountId?: string },
  ): Promise<void>;
  addChatLabel?(chatJid: string, labelId: string): Promise<void>;
  removeChatLabel?(chatJid: string, labelId: string): Promise<void>;
  getLabels?(): Promise<
    { id: string; name: string; color: number; deleted: boolean; predefinedId?: string }[]
  >;
  createLabel?(
    name: string,
    color: number,
  ): Promise<{ id: string; name: string; color: number } | undefined>;
  addLabel?(
    chatJid: string,
    labels: { id: string; name?: string; color?: number; deleted?: boolean },
  ): Promise<void>;
  addMessageLabel?(chatJid: string, messageId: string, labelId: string): Promise<void>;
  removeMessageLabel?(chatJid: string, messageId: string, labelId: string): Promise<void>;
  onWhatsApp?(...phoneNumbers: string[]): Promise<{ jid: string; exists: boolean }[] | undefined>;
  getBusinessProfile?(jid: string): Promise<any>;
  chatModify?(mod: any, jid: string): Promise<void>;
}
