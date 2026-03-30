import type { GatewayMessageChannel } from "../../utils/message-channel.js";
export declare function runSessionsSendA2AFlow(params: {
    targetSessionKey: string;
    displayKey: string;
    message: string;
    announceTimeoutMs: number;
    maxPingPongTurns: number;
    requesterSessionKey?: string;
    requesterChannel?: GatewayMessageChannel;
    roundOneReply?: string;
    waitRunId?: string;
}): Promise<void>;
