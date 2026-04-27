import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
export type SubagentListItem = {
    index: number;
    line: string;
    runId: string;
    sessionKey: string;
    label: string;
    task: string;
    status: string;
    pendingDescendants: number;
    runtime: string;
    runtimeMs: number;
    childSessions?: string[];
    model?: string;
    totalTokens?: number;
    startedAt?: number;
    endedAt?: number;
};
export type BuiltSubagentList = {
    total: number;
    active: SubagentListItem[];
    recent: SubagentListItem[];
    text: string;
};
export type SessionEntryResolution = {
    storePath: string;
    entry: SessionEntry | undefined;
};
export declare function resolveSessionEntryForKey(params: {
    cfg: OpenClawConfig;
    key: string;
    cache: Map<string, Record<string, SessionEntry>>;
}): SessionEntryResolution;
export declare function buildLatestSubagentRunIndex(runs: Map<string, SubagentRunRecord>, options?: {
    now?: number;
}): {
    latestByChildSessionKey: Map<string, SubagentRunRecord>;
    childSessionsByController: Map<string, string[]>;
};
export declare function createPendingDescendantCounter(runsSnapshot?: Map<string, SubagentRunRecord>): (sessionKey: string) => number;
export declare function isActiveSubagentRun(entry: SubagentRunRecord, pendingDescendantCount: (sessionKey: string) => number): boolean;
export declare function buildSubagentList(params: {
    cfg: OpenClawConfig;
    runs: SubagentRunRecord[];
    recentMinutes: number;
    taskMaxChars?: number;
}): BuiltSubagentList;
