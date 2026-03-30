export declare const WHATSAPP_GROUP_INTRO_HINT = "WhatsApp IDs: SenderId is the participant JID (group participant id).";
export declare function resolveWhatsAppGroupIntroHint(): string;
export declare function resolveWhatsAppMentionStripPatterns(ctx: {
    To?: string | null;
}): string[];
