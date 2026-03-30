import type { loadConfig } from "../../../config/config.js";
import type { resolveAgentRoute } from "../../../routing/resolve-route.js";
import type { WebInboundMsg } from "../types.js";
import type { GroupHistoryEntry } from "./process-message.js";
export declare function maybeBroadcastMessage(params: {
    cfg: ReturnType<typeof loadConfig>;
    msg: WebInboundMsg;
    peerId: string;
    route: ReturnType<typeof resolveAgentRoute>;
    groupHistoryKey: string;
    groupHistories: Map<string, GroupHistoryEntry[]>;
    processMessage: (msg: WebInboundMsg, route: ReturnType<typeof resolveAgentRoute>, groupHistoryKey: string, opts?: {
        groupHistory?: GroupHistoryEntry[];
        suppressGroupHistoryClear?: boolean;
    }) => Promise<boolean>;
}): Promise<boolean>;
