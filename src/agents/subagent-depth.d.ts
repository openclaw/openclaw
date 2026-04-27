import type { OpenClawConfig } from "../config/types.openclaw.js";
type SessionDepthEntry = {
    sessionId?: unknown;
    spawnDepth?: unknown;
    spawnedBy?: unknown;
};
export declare function getSubagentDepthFromSessionStore(sessionKey: string | undefined | null, opts?: {
    cfg?: OpenClawConfig;
    store?: Record<string, SessionDepthEntry>;
}): number;
export {};
