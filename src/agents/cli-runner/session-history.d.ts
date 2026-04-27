import type { OpenClawConfig } from "../../config/types.openclaw.js";
export declare const MAX_CLI_SESSION_HISTORY_FILE_BYTES: number;
export declare const MAX_CLI_SESSION_HISTORY_MESSAGES = 100;
export declare function loadCliSessionHistoryMessages(params: {
    sessionId: string;
    sessionFile: string;
    sessionKey?: string;
    agentId?: string;
    config?: OpenClawConfig;
}): unknown[];
