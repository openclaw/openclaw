import type { AckReactionHandle } from "openclaw/plugin-sdk/channel-feedback";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import type { WebInboundMsg } from "../types.js";
import type { GroupHistoryEntry } from "./inbound-context.js";
export declare function maybeBroadcastMessage(params: {
    cfg: OpenClawConfig;
    msg: WebInboundMsg;
    peerId: string;
    route: ReturnType<typeof resolveAgentRoute>;
    groupHistoryKey: string;
    groupHistories: Map<string, GroupHistoryEntry[]>;
    processMessage: (msg: WebInboundMsg, route: ReturnType<typeof resolveAgentRoute>, groupHistoryKey: string, opts?: {
        groupHistory?: GroupHistoryEntry[];
        suppressGroupHistoryClear?: boolean;
        preflightAudioTranscript?: string | null;
        ackAlreadySent?: boolean;
        ackReaction?: AckReactionHandle | null;
    }) => Promise<boolean>;
    preflightAudioTranscript?: string | null;
    ackAlreadySent?: boolean;
    ackReaction?: AckReactionHandle | null;
}): Promise<boolean>;
