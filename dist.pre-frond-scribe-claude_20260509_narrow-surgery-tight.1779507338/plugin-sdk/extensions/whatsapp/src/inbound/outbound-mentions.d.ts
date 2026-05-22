import type { AnyMessageContent } from "baileys";
export type WhatsAppOutboundMentionParticipant = string | {
    id?: string | null;
    lid?: string | null;
    phoneNumber?: string | null;
    e164?: string | null;
};
export type WhatsAppOutboundMentionResolution = {
    text: string;
    mentionedJids: string[];
};
export declare function mayContainWhatsAppOutboundMention(text: string): boolean;
export declare function resolveWhatsAppOutboundMentions(params: {
    chatJid: string;
    text: string;
    participants?: readonly WhatsAppOutboundMentionParticipant[];
}): WhatsAppOutboundMentionResolution;
export declare function addWhatsAppOutboundMentionsToContent(content: AnyMessageContent, mentionedJids: readonly string[]): AnyMessageContent;
