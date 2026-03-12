export type InboundAccessControlResult = {
    allowed: boolean;
    shouldMarkRead: boolean;
    isSelfChat: boolean;
    resolvedAccountId: string;
};
declare function resolveWhatsAppRuntimeGroupPolicy(params: {
    providerConfigPresent: boolean;
    groupPolicy?: "open" | "allowlist" | "disabled";
    defaultGroupPolicy?: "open" | "allowlist" | "disabled";
}): {
    groupPolicy: "open" | "allowlist" | "disabled";
    providerMissingFallbackApplied: boolean;
};
export declare function checkInboundAccessControl(params: {
    accountId: string;
    from: string;
    selfE164: string | null;
    senderE164: string | null;
    group: boolean;
    pushName?: string;
    isFromMe: boolean;
    messageTimestampMs?: number;
    connectedAtMs?: number;
    pairingGraceMs?: number;
    sock: {
        sendMessage: (jid: string, content: {
            text: string;
        }) => Promise<unknown>;
    };
    remoteJid: string;
}): Promise<InboundAccessControlResult>;
export declare const __testing: {
    resolveWhatsAppRuntimeGroupPolicy: typeof resolveWhatsAppRuntimeGroupPolicy;
};
export {};
