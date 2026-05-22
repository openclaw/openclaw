export declare class WhatsAppRetryableInboundError extends Error {
    constructor(message: string, options?: ErrorOptions);
}
export declare function resetWebInboundDedupe(): void;
export declare function claimRecentInboundMessage(key: string): Promise<boolean>;
export declare function commitRecentInboundMessage(key: string): Promise<void>;
export declare function releaseRecentInboundMessage(key: string, error?: unknown): void;
export declare function rememberRecentOutboundMessage(params: {
    accountId: string;
    remoteJid: string;
    messageId: string;
}): void;
export declare function isRecentOutboundMessage(params: {
    accountId: string;
    remoteJid: string;
    messageId: string;
}): boolean;
