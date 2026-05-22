import type { MiscMessageGenerationOptions } from "baileys";
type QuotedMeta = {
    participant?: string;
    participantE164?: string;
    body?: string;
    fromMe?: boolean;
};
type QuotedMetaLookup = QuotedMeta & {
    remoteJid: string;
};
export declare function cacheInboundMessageMeta(accountId: string, remoteJid: string, messageId: string, meta: QuotedMeta): void;
export declare function lookupInboundMessageMeta(accountId: string, remoteJid: string, messageId: string): QuotedMeta | undefined;
export declare function lookupInboundMessageMetaForTarget(accountId: string, targetJid: string, messageId: string): QuotedMetaLookup | undefined;
export declare function buildQuotedMessageOptions(params: {
    messageId?: string | null;
    remoteJid?: string | null;
    fromMe?: boolean;
    participant?: string;
    /** Original message text — shown in the quote preview bubble. */
    messageText?: string;
}): MiscMessageGenerationOptions | undefined;
export {};
