import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveWhatsAppInboundPolicy } from "../inbound-policy.js";
export type InboundAccessControlResult = {
    allowed: boolean;
    shouldMarkRead: boolean;
    isSelfChat: boolean;
    resolvedAccountId: string;
};
export declare function checkInboundAccessControl(params: {
    cfg: OpenClawConfig;
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
    verbose?: boolean;
    sock: {
        sendMessage: (jid: string, content: {
            text: string;
        }) => Promise<unknown>;
    };
    remoteJid: string;
}): Promise<InboundAccessControlResult>;
export declare const testing: {
    resolveWhatsAppInboundPolicy: typeof resolveWhatsAppInboundPolicy;
};
export { testing as __testing };
