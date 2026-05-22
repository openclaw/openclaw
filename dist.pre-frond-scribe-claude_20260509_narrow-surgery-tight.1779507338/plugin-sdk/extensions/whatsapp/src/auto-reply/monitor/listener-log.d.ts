export declare function formatWhatsAppInboundListeningLog(account: {
    groups?: Record<string, unknown>;
    groupPolicy: "open" | "allowlist" | "disabled";
    hasGroupAllowFrom: boolean;
}): string;
