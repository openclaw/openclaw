export type AckReactionScope = "all" | "direct" | "group-all" | "group-mentions" | "off" | "none";
export type WhatsAppAckReactionMode = "always" | "mentions" | "never";
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
export declare function removeAckReactionAfterReply(params: {
    removeAfterReply: boolean;
    ackReactionPromise: Promise<boolean> | null;
    ackReactionValue: string | null;
    remove: () => Promise<void>;
    onError?: (err: unknown) => void;
}): void;
