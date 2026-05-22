import type { OpenClawConfig } from "../config/types.openclaw.js";
export type ActiveSessionForShutdown = {
    cfg: OpenClawConfig;
    sessionKey: string;
    sessionId: string;
    storePath: string;
    sessionFile?: string;
    agentId?: string;
};
export declare function noteActiveSessionForShutdown(entry: ActiveSessionForShutdown): void;
export declare function forgetActiveSessionForShutdown(sessionId: string | undefined): void;
export declare function listActiveSessionsForShutdown(): ActiveSessionForShutdown[];
export declare function clearActiveSessionsForShutdownTracker(): void;
