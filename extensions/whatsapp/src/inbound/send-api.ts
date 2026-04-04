import type { AnyMessageContent, WAPresence } from "@whiskeysockets/baileys";
import { recordChannelActivity } from "openclaw/plugin-sdk/channel-runtime";
import { toWhatsappJid } from "openclaw/plugin-sdk/text-runtime";
import type { ActiveWebSendOptions } from "../active-listener.js";

export type LabelActionBody =
  | { id: string; name?: string; color?: number; deleted?: boolean; predefinedId?: number }
  | { id: string }[];

function recordWhatsAppOutbound(accountId: string) {
  recordChannelActivity({
    channel: "whatsapp",
    accountId,
    direction: "outbound",
  });
}

function resolveOutboundMessageId(result: unknown): string {
  return typeof result === "object" && result && "key" in result
    ? String((result as { key?: { id?: string } }).key?.id ?? "unknown")
    : "unknown";
}

export function createWebSendApi(params: {
  sock: {
    sendMessage: (jid: string, content: AnyMessageContent) => Promise<unknown>;
    sendPresenceUpdate: (presence: WAPresence, jid?: string) => Promise<unknown>;
    addChatLabel: (jid: string, labelId: string) => Promise<void>;
    removeChatLabel: (jid: string, labelId: string) => Promise<void>;
    getLabels?: () => Promise<
      { id: string; name: string; color: number; deleted: boolean; predefinedId?: string }[]
    >;
    createLabel?: (
      name: string,
      color: number,
    ) => Promise<{ id: string; name: string; color: number }>;
    addLabel?: (jid: string, labels: LabelActionBody) => Promise<void>;
    addMessageLabel?: (jid: string, messageId: string, labelId: string) => Promise<void>;
    removeMessageLabel?: (jid: string, messageId: string, labelId: string) => Promise<void>;
    onWhatsApp?: (
      ...phoneNumbers: string[]
    ) => Promise<{ jid: string; exists: boolean }[] | undefined>;
    getBusinessProfile?: (jid: string) => Promise<unknown>;
    fetchStatus?: (...jids: string[]) => Promise<unknown>;
    chatModify?: (mod: unknown, jid: string) => Promise<void>;
    fetchBlocklist?: () => Promise<(string | undefined)[]>;
    profilePictureUrl?: (
      jid: string,
      type?: "preview" | "image",
      timeoutMs?: number,
    ) => Promise<string | undefined>;
    groupMetadata?: (jid: string) => Promise<unknown>;
    readMessages?: (keys: unknown[]) => Promise<void>;
    star?: (
      jid: string,
      messages: { id: string; fromMe?: boolean }[],
      star: boolean,
    ) => Promise<void>;
    fetchMessageHistory?: (
      count: number,
      oldestMsgKey: { remoteJid: string; fromMe: boolean; id: string },
      oldestMsgTimestamp: number,
    ) => Promise<string>;
  };
  defaultAccountId: string;
}) {
  return {
    sendMessage: async (
      to: string,
      text: string,
      mediaBuffer?: Buffer,
      mediaType?: string,
      sendOptions?: ActiveWebSendOptions,
    ): Promise<{ messageId: string }> => {
      const jid = toWhatsappJid(to);
      let payload: AnyMessageContent;
      if (mediaBuffer) {
        mediaType ??= "application/octet-stream";
      }
      if (mediaBuffer && mediaType) {
        if (mediaType.startsWith("image/")) {
          payload = {
            image: mediaBuffer,
            caption: text || undefined,
            mimetype: mediaType,
          };
        } else if (mediaType.startsWith("audio/")) {
          payload = { audio: mediaBuffer, ptt: true, mimetype: mediaType };
        } else if (mediaType.startsWith("video/")) {
          const gifPlayback = sendOptions?.gifPlayback;
          payload = {
            video: mediaBuffer,
            caption: text || undefined,
            mimetype: mediaType,
            ...(gifPlayback ? { gifPlayback: true } : {}),
          };
        } else {
          const fileName = sendOptions?.fileName?.trim() || "file";
          payload = {
            document: mediaBuffer,
            fileName,
            caption: text || undefined,
            mimetype: mediaType,
          };
        }
      } else {
        payload = { text };
      }
      const result = await params.sock.sendMessage(jid, payload);
      const accountId = sendOptions?.accountId ?? params.defaultAccountId;
      recordWhatsAppOutbound(accountId);
      const messageId = resolveOutboundMessageId(result);
      return { messageId };
    },
    sendPoll: async (
      to: string,
      poll: { question: string; options: string[]; maxSelections?: number },
    ): Promise<{ messageId: string }> => {
      const jid = toWhatsappJid(to);
      const result = await params.sock.sendMessage(jid, {
        poll: {
          name: poll.question,
          values: poll.options,
          selectableCount: poll.maxSelections ?? 1,
        },
      } as AnyMessageContent);
      recordWhatsAppOutbound(params.defaultAccountId);
      const messageId = resolveOutboundMessageId(result);
      return { messageId };
    },
    sendReaction: async (
      chatJid: string,
      messageId: string,
      emoji: string,
      fromMe: boolean,
      participant?: string,
    ): Promise<void> => {
      const jid = toWhatsappJid(chatJid);
      await params.sock.sendMessage(jid, {
        react: {
          text: emoji,
          key: {
            remoteJid: jid,
            id: messageId,
            fromMe,
            participant: participant ? toWhatsappJid(participant) : undefined,
          },
        },
      } as AnyMessageContent);
    },
    addChatLabel: async (chatJid: string, labelId: string): Promise<void> => {
      const jid = toWhatsappJid(chatJid);
      await params.sock.addChatLabel(jid, labelId);
    },
    removeChatLabel: async (chatJid: string, labelId: string): Promise<void> => {
      const jid = toWhatsappJid(chatJid);
      await params.sock.removeChatLabel(jid, labelId);
    },
    getLabels: async () => {
      return (await params.sock.getLabels?.()) ?? [];
    },
    createLabel: async (name: string, color: number) => {
      return await params.sock.createLabel?.(name, color);
    },
    addLabel: async (chatJid: string, labels: LabelActionBody): Promise<void> => {
      const jid = toWhatsappJid(chatJid);
      await params.sock.addLabel?.(jid, labels);
    },
    addMessageLabel: async (chatJid: string, messageId: string, labelId: string): Promise<void> => {
      const jid = toWhatsappJid(chatJid);
      await params.sock.addMessageLabel?.(jid, messageId, labelId);
    },
    removeMessageLabel: async (
      chatJid: string,
      messageId: string,
      labelId: string,
    ): Promise<void> => {
      const jid = toWhatsappJid(chatJid);
      await params.sock.removeMessageLabel?.(jid, messageId, labelId);
    },
    onWhatsApp: async (...phoneNumbers: string[]) => {
      return await params.sock.onWhatsApp?.(...phoneNumbers);
    },
    getBusinessProfile: async (jid: string) => {
      return await params.sock.getBusinessProfile?.(toWhatsappJid(jid));
    },
    fetchStatus: async (...jids: string[]) => {
      return await params.sock.fetchStatus?.(...jids);
    },
    chatModify: async (mod: unknown, jid: string): Promise<void> => {
      await params.sock.chatModify?.(mod, toWhatsappJid(jid));
    },
    fetchBlocklist: async () => {
      return await params.sock.fetchBlocklist?.();
    },
    profilePictureUrl: async (jid: string, type?: "preview" | "image", timeoutMs?: number) => {
      return await params.sock.profilePictureUrl?.(toWhatsappJid(jid), type, timeoutMs);
    },
    groupMetadata: async (jid: string) => {
      return await params.sock.groupMetadata?.(toWhatsappJid(jid));
    },
    readMessages: async (keys: unknown[]): Promise<void> => {
      await params.sock.readMessages?.(keys);
    },
    star: async (
      jid: string,
      messages: { id: string; fromMe?: boolean }[],
      star: boolean,
    ): Promise<void> => {
      await params.sock.star?.(toWhatsappJid(jid), messages, star);
    },
    fetchMessageHistory: async (
      count: number,
      oldestMsgKey: { remoteJid: string; fromMe: boolean; id: string },
      oldestMsgTimestamp: number,
    ): Promise<string> => {
      if (!params.sock.fetchMessageHistory) {
        throw new Error("fetchMessageHistory not available on this socket");
      }
      return await params.sock.fetchMessageHistory(count, oldestMsgKey, oldestMsgTimestamp);
    },
    sendComposingTo: async (to: string): Promise<void> => {
      const jid = toWhatsappJid(to);
      await params.sock.sendPresenceUpdate("composing", jid);
    },
  } as const;
}
