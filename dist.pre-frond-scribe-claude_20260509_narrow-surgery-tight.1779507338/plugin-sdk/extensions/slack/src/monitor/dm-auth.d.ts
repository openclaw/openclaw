import type { SlackMonitorContext } from "./context.js";
export declare function authorizeSlackDirectMessage(params: {
    ctx: SlackMonitorContext;
    accountId: string;
    senderId: string;
    allowFromLower: string[];
    resolveSenderName: (senderId: string) => Promise<{
        name?: string;
    }>;
    sendPairingReply: (text: string) => Promise<void>;
    onDisabled: () => Promise<void> | void;
    onUnauthorized: (params: {
        allowMatchMeta: string;
        senderName?: string;
    }) => Promise<void> | void;
    log: (message: string) => void;
}): Promise<boolean>;
