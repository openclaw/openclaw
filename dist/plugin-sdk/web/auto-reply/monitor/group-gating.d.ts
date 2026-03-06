import type { loadConfig } from "../../../config/config.js";
import type { MentionConfig } from "../mentions.js";
import type { WebInboundMsg } from "../types.js";
export type GroupHistoryEntry = {
    sender: string;
    body: string;
    timestamp?: number;
    id?: string;
    senderJid?: string;
};
type ApplyGroupGatingParams = {
    cfg: ReturnType<typeof loadConfig>;
    msg: WebInboundMsg;
    conversationId: string;
    groupHistoryKey: string;
    agentId: string;
    sessionKey: string;
    baseMentionConfig: MentionConfig;
    authDir?: string;
    groupHistories: Map<string, GroupHistoryEntry[]>;
    groupHistoryLimit: number;
    groupMemberNames: Map<string, Map<string, string>>;
    logVerbose: (msg: string) => void;
    replyLogger: {
        debug: (obj: unknown, msg: string) => void;
    };
};
export declare function applyGroupGating(params: ApplyGroupGatingParams): {
    readonly shouldProcess: false;
} | {
    shouldProcess: boolean;
};
export {};
