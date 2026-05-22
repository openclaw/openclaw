export type OutboundMirror = {
    sessionKey: string;
    agentId?: string;
    text?: string;
    mediaUrls?: string[];
    idempotencyKey?: string;
};
export type DeliveryMirror = OutboundMirror & {
    /** Whether this message is being sent in a group/channel context */
    isGroup?: boolean;
    /** Group or channel identifier for correlation with received events */
    groupId?: string;
};
