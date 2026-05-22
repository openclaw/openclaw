import type { WAMessage, WAMessageKey } from "baileys";
import { type MessageReceipt } from "openclaw/plugin-sdk/channel-message";
export type WhatsAppSendKind = "media" | "poll" | "reaction" | "text";
type WhatsAppSendKey = Omit<Pick<WAMessageKey, "fromMe" | "id" | "participant" | "remoteJid">, "id"> & {
    id: string;
};
export type WhatsAppSendResult = {
    kind: WhatsAppSendKind;
    messageId: string;
    receipt?: MessageReceipt;
    keys: WhatsAppSendKey[];
    providerAccepted: boolean;
};
export declare function normalizeWhatsAppSendResult(result: WAMessage | undefined, kind: WhatsAppSendKind): WhatsAppSendResult;
export declare function combineWhatsAppSendResults(kind: WhatsAppSendKind, results: readonly WhatsAppSendResult[]): WhatsAppSendResult;
export declare function listWhatsAppSendResultMessageIds(result: WhatsAppSendResult): string[];
export {};
