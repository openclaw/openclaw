import type { loadConfig } from "../../../config/config.js";
import type { WebInboundMsg } from "../types.js";
export declare function maybeSendAckReaction(params: {
    cfg: ReturnType<typeof loadConfig>;
    msg: WebInboundMsg;
    agentId: string;
    sessionKey: string;
    conversationId: string;
    verbose: boolean;
    accountId?: string;
    info: (obj: unknown, msg: string) => void;
    warn: (obj: unknown, msg: string) => void;
}): void;
