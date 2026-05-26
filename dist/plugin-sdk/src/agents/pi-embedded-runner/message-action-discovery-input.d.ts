import type { OpenClawConfig } from "../../config/types.openclaw.js";
export declare function buildEmbeddedMessageActionDiscoveryInput(params: {
    cfg?: OpenClawConfig;
    channel: string;
    currentChannelId?: string | null;
    currentThreadTs?: string | null;
    currentMessageId?: string | number | null;
    accountId?: string | null;
    sessionKey?: string | null;
    sessionId?: string | null;
    agentId?: string | null;
    senderId?: string | null;
    senderIsOwner?: boolean;
}): {
    cfg: OpenClawConfig | undefined;
    channel: string;
    currentChannelId: string | undefined;
    currentThreadTs: string | undefined;
    currentMessageId: string | number | undefined;
    accountId: string | undefined;
    sessionKey: string | undefined;
    sessionId: string | undefined;
    agentId: string | undefined;
    requesterSenderId: string | undefined;
    senderIsOwner: boolean | undefined;
};
