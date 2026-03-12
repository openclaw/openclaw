import type { SessionEntry } from "../../config/sessions.js";
import type { TypingMode } from "../../config/types.js";
import type { GetReplyOptions } from "../types.js";
import type { FollowupRun } from "./queue.js";
import type { TypingController } from "./typing.js";
export declare function createFollowupRunner(params: {
    opts?: GetReplyOptions;
    typing: TypingController;
    typingMode: TypingMode;
    sessionEntry?: SessionEntry;
    sessionStore?: Record<string, SessionEntry>;
    sessionKey?: string;
    storePath?: string;
    defaultModel: string;
    agentCfgContextTokens?: number;
}): (queued: FollowupRun) => Promise<void>;
