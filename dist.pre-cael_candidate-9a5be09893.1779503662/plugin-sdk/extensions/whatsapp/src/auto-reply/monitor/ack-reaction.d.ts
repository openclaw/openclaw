import { type AckReactionHandle } from "openclaw/plugin-sdk/channel-feedback";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { WebInboundMsg } from "../types.js";
export declare function maybeSendAckReaction(params: {
    cfg: OpenClawConfig;
    msg: WebInboundMsg;
    agentId: string;
    sessionKey: string;
    conversationId: string;
    verbose: boolean;
    accountId?: string;
    info: (obj: unknown, msg: string) => void;
    warn: (obj: unknown, msg: string) => void;
}): Promise<AckReactionHandle | null>;
