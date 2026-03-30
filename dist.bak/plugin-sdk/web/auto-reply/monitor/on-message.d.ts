import type { getReplyFromConfig } from "../../../auto-reply/reply.js";
import { loadConfig } from "../../../config/config.js";
import type { MentionConfig } from "../mentions.js";
import type { WebInboundMsg } from "../types.js";
import type { EchoTracker } from "./echo.js";
import type { GroupHistoryEntry } from "./group-gating.js";
export declare function createWebOnMessageHandler(params: {
    cfg: ReturnType<typeof loadConfig>;
    verbose: boolean;
    connectionId: string;
    maxMediaBytes: number;
    groupHistoryLimit: number;
    groupHistories: Map<string, GroupHistoryEntry[]>;
    groupMemberNames: Map<string, Map<string, string>>;
    echoTracker: EchoTracker;
    backgroundTasks: Set<Promise<unknown>>;
    replyResolver: typeof getReplyFromConfig;
    replyLogger: ReturnType<(typeof import("../../../logging.js"))["getChildLogger"]>;
    baseMentionConfig: MentionConfig;
    account: {
        authDir?: string;
        accountId?: string;
    };
}): (msg: WebInboundMsg) => Promise<void>;
