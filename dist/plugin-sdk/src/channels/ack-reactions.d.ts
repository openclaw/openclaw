export type AckReactionScope = "all" | "direct" | "group-all" | "group-mentions" | "off" | "none";
export type WhatsAppAckReactionMode = "always" | "mentions" | "never";
export type AckReactionHandle = {
    ackReactionPromise: Promise<boolean>;
    ackReactionValue: string;
    remove: () => Promise<void>;
};
export type AckReactionGateParams = {
    scope: AckReactionScope | undefined;
    isDirect: boolean;
    isGroup: boolean;
    isMentionableGroup: boolean;
    requireMention: boolean;
    canDetectMention: boolean;
    effectiveWasMentioned: boolean;
    shouldBypassMention?: boolean;
};
export declare function shouldAckReaction(params: AckReactionGateParams): boolean;
export declare function shouldAckReactionForWhatsApp(params: {
    emoji: string;
    isDirect: boolean;
    isGroup: boolean;
    directEnabled: boolean;
    groupMode: WhatsAppAckReactionMode;
    wasMentioned: boolean;
    groupActivated: boolean;
}): boolean;
export declare function createAckReactionHandle(params: {
    ackReactionValue: string;
    send: () => Promise<void>;
    remove: () => Promise<void>;
    onSendError?: (err: unknown) => void;
}): AckReactionHandle | null;
export declare function removeAckReactionAfterReply(params: {
    removeAfterReply: boolean;
    ackReactionPromise: Promise<boolean> | null;
    ackReactionValue: string | null;
    remove: () => Promise<void>;
    onError?: (err: unknown) => void;
}): void;
export declare function removeAckReactionHandleAfterReply(params: {
    removeAfterReply: boolean;
    ackReaction: AckReactionHandle | null | undefined;
    onError?: (err: unknown) => void;
}): void;
