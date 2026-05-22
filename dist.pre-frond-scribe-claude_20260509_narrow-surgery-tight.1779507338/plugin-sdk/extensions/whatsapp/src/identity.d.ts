export type WhatsAppIdentity = {
    jid?: string | null;
    lid?: string | null;
    e164?: string | null;
    name?: string | null;
    label?: string | null;
};
export type WhatsAppSelfIdentity = {
    jid?: string | null;
    lid?: string | null;
    e164?: string | null;
};
export type WhatsAppReplyContext = {
    id?: string;
    body: string;
    sender?: WhatsAppIdentity | null;
};
type LegacySenderLike = {
    sender?: WhatsAppIdentity;
    senderJid?: string;
    senderE164?: string;
    senderName?: string;
};
type LegacySelfLike = {
    self?: WhatsAppSelfIdentity;
    selfJid?: string | null;
    selfLid?: string | null;
    selfE164?: string | null;
};
type LegacyReplyLike = {
    replyTo?: WhatsAppReplyContext;
    replyToId?: string;
    replyToBody?: string;
    replyToSender?: string;
    replyToSenderJid?: string;
    replyToSenderE164?: string;
};
type LegacyMentionsLike = {
    mentions?: string[];
    mentionedJids?: string[];
};
export declare function resolveComparableIdentity(identity: WhatsAppIdentity | WhatsAppSelfIdentity | null | undefined, authDir?: string): WhatsAppIdentity;
export declare function getComparableIdentityValues(identity: WhatsAppIdentity | WhatsAppSelfIdentity | null | undefined): string[];
export declare function identitiesOverlap(left: WhatsAppIdentity | WhatsAppSelfIdentity | null | undefined, right: WhatsAppIdentity | WhatsAppSelfIdentity | null | undefined): boolean;
export declare function getSenderIdentity(msg: LegacySenderLike, authDir?: string): WhatsAppIdentity;
export declare function getSelfIdentity(msg: LegacySelfLike, authDir?: string): WhatsAppSelfIdentity;
export declare function getReplyContext(msg: LegacyReplyLike, authDir?: string): WhatsAppReplyContext | null;
export declare function getMentionIdentities(msg: LegacyMentionsLike, authDir?: string): WhatsAppIdentity[];
export declare function getPrimaryIdentityId(identity: WhatsAppIdentity | null | undefined): string | null;
export {};
