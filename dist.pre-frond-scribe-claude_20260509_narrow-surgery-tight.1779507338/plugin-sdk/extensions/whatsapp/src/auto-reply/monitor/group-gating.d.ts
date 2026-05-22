import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
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
    cfg: OpenClawConfig;
    msg: WebInboundMsg;
    mentionText?: string;
    deferMissingMention?: boolean;
    conversationId: string;
    groupHistoryKey: string;
    agentId: string;
    sessionKey: string;
    baseMentionConfig: MentionConfig;
    authDir?: string;
    groupHistories: Map<string, GroupHistoryEntry[]>;
    groupHistoryLimit: number;
    groupMemberNames: Map<string, Map<string, string>>;
    selfChatMode?: boolean;
    logVerbose: (msg: string) => void;
    replyLogger: {
        debug: (obj: unknown, msg: string) => void;
    };
};
export declare function applyGroupGating(params: ApplyGroupGatingParams): Promise<{
    readonly shouldProcess: false;
} | {
    shouldProcess: boolean;
    readonly needsMentionText?: undefined;
} | {
    readonly shouldProcess: false;
    readonly needsMentionText: true;
}>;
export {};
