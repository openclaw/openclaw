export type WhatsAppQaDriverObservedMessage = {
    fromJid?: string;
    fromPhoneE164?: string | null;
    messageId?: string;
    observedAt: string;
    text: string;
};
export type WhatsAppQaDriverSession = {
    close: () => Promise<void>;
    getObservedMessages: () => WhatsAppQaDriverObservedMessage[];
    sendText: (to: string, text: string) => Promise<{
        messageId?: string;
    }>;
    waitForMessage: (params: {
        match: (message: WhatsAppQaDriverObservedMessage) => boolean;
        timeoutMs: number;
    }) => Promise<WhatsAppQaDriverObservedMessage>;
};
export declare function startWhatsAppQaDriverSession(params: {
    authDir: string;
    connectionTimeoutMs?: number;
}): Promise<WhatsAppQaDriverSession>;
