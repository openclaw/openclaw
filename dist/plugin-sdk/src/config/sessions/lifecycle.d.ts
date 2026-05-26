import { type SessionFilePathOptions } from "./paths.js";
import type { SessionEntry } from "./types.js";
type SessionLifecycleEntry = Pick<SessionEntry, "sessionId" | "sessionFile" | "sessionStartedAt" | "lastInteractionAt" | "updatedAt">;
export declare function readSessionHeaderStartedAtMs(params: {
    entry: SessionLifecycleEntry | undefined;
    agentId?: string;
    storePath?: string;
    pathOptions?: SessionFilePathOptions;
}): number | undefined;
export declare function resolveSessionLifecycleTimestamps(params: {
    entry: SessionLifecycleEntry | undefined;
    agentId?: string;
    storePath?: string;
    pathOptions?: SessionFilePathOptions;
}): {
    sessionStartedAt?: number;
    lastInteractionAt?: number;
};
export {};
