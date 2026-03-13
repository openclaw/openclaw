import type { proto } from "@whiskeysockets/baileys";
import { type NormalizedLocation } from "../../channels/location.js";
export declare function extractMentionedJids(rawMessage: proto.IMessage | undefined): string[] | undefined;
export declare function extractText(rawMessage: proto.IMessage | undefined): string | undefined;
export declare function extractMediaPlaceholder(rawMessage: proto.IMessage | undefined): string | undefined;
export declare function extractLocationData(rawMessage: proto.IMessage | undefined): NormalizedLocation | null;
export declare function describeReplyContext(rawMessage: proto.IMessage | undefined): {
    id?: string;
    body: string;
    sender: string;
    senderJid?: string;
    senderE164?: string;
} | null;
