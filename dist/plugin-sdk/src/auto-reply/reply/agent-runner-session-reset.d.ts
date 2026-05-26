import type { SessionEntry } from "../../config/sessions.js";
import { updateSessionStore } from "../../config/sessions.js";
import { generateSecureUuid } from "../../infra/secure-random.js";
import { refreshQueuedFollowupSession, type FollowupRun } from "./queue.js";
type ResetSessionOptions = {
    failureLabel: string;
    buildLogMessage: (nextSessionId: string) => string;
    cleanupTranscripts?: boolean;
};
declare const deps: {
    generateSecureUuid: typeof generateSecureUuid;
    updateSessionStore: typeof updateSessionStore;
    refreshQueuedFollowupSession: typeof refreshQueuedFollowupSession;
    error: (message: string) => void;
};
export declare function setAgentRunnerSessionResetTestDeps(overrides?: Partial<typeof deps>): void;
export declare function resetReplyRunSession(params: {
    options: ResetSessionOptions;
    sessionKey?: string;
    queueKey: string;
    activeSessionEntry?: SessionEntry;
    activeSessionStore?: Record<string, SessionEntry>;
    storePath?: string;
    messageThreadId?: string;
    followupRun: FollowupRun;
    onActiveSessionEntry: (entry: SessionEntry) => void;
    onNewSession: (newSessionId: string, nextSessionFile: string) => void;
}): Promise<boolean>;
export {};
