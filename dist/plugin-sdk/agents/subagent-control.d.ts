import { type SubagentTargetResolution } from "../auto-reply/reply/subagents-utils.js";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { type SubagentRunRecord } from "./subagent-registry.js";
export declare const DEFAULT_RECENT_MINUTES = 30;
export declare const MAX_RECENT_MINUTES: number;
export declare const MAX_STEER_MESSAGE_CHARS = 4000;
export declare const STEER_RATE_LIMIT_MS = 2000;
export declare const STEER_ABORT_SETTLE_TIMEOUT_MS = 5000;
export type SessionEntryResolution = {
    storePath: string;
    entry: SessionEntry | undefined;
};
export type ResolvedSubagentController = {
    controllerSessionKey: string;
    callerSessionKey: string;
    callerIsSubagent: boolean;
    controlScope: "children" | "none";
};
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
export declare function resolveSessionEntryForKey(params: {
    cfg: OpenClawConfig;
    key: string;
    cache: Map<string, Record<string, SessionEntry>>;
}): SessionEntryResolution;
export declare function resolveSubagentController(params: {
    cfg: OpenClawConfig;
    agentSessionKey?: string;
}): ResolvedSubagentController;
export declare function listControlledSubagentRuns(controllerSessionKey: string): SubagentRunRecord[];
export declare function createPendingDescendantCounter(): (sessionKey: string) => number;
export declare function isActiveSubagentRun(entry: SubagentRunRecord, pendingDescendantCount: (sessionKey: string) => number): boolean;
export declare function buildSubagentList(params: {
    cfg: OpenClawConfig;
    runs: SubagentRunRecord[];
    recentMinutes: number;
    taskMaxChars?: number;
}): BuiltSubagentList;
export declare function killAllControlledSubagentRuns(params: {
    cfg: OpenClawConfig;
    controller: ResolvedSubagentController;
    runs: SubagentRunRecord[];
}): Promise<{
    status: "forbidden";
    error: string;
    killed: number;
    labels: never[];
} | {
    status: "ok";
    killed: number;
    labels: string[];
    error?: undefined;
}>;
export declare function killControlledSubagentRun(params: {
    cfg: OpenClawConfig;
    controller: ResolvedSubagentController;
    entry: SubagentRunRecord;
}): Promise<{
    status: "forbidden";
    runId: string;
    sessionKey: string;
    error: string;
    label?: undefined;
    text?: undefined;
    cascadeKilled?: undefined;
    cascadeLabels?: undefined;
} | {
    status: "done";
    runId: string;
    sessionKey: string;
    label: string;
    text: string;
    error?: undefined;
    cascadeKilled?: undefined;
    cascadeLabels?: undefined;
} | {
    status: "ok";
    runId: string;
    sessionKey: string;
    label: string;
    cascadeKilled: number;
    cascadeLabels: string[] | undefined;
    text: string;
    error?: undefined;
}>;
export declare function steerControlledSubagentRun(params: {
    cfg: OpenClawConfig;
    controller: ResolvedSubagentController;
    entry: SubagentRunRecord;
    message: string;
}): Promise<{
    status: "forbidden" | "done" | "rate_limited" | "error";
    runId?: string;
    sessionKey: string;
    sessionId?: string;
    error?: string;
    text?: string;
} | {
    status: "accepted";
    runId: string;
    sessionKey: string;
    sessionId?: string;
    mode: "restart";
    label: string;
    text: string;
}>;
export declare function sendControlledSubagentMessage(params: {
    cfg: OpenClawConfig;
    entry: SubagentRunRecord;
    message: string;
}): Promise<{
    status: "timeout";
    runId: string;
    error?: undefined;
    replyText?: undefined;
} | {
    status: "error";
    runId: string;
    error: string;
    replyText?: undefined;
} | {
    status: "ok";
    runId: string;
    replyText: string | undefined;
    error?: undefined;
}>;
export declare function resolveControlledSubagentTarget(runs: SubagentRunRecord[], token: string | undefined, options?: {
    recentMinutes?: number;
    isActive?: (entry: SubagentRunRecord) => boolean;
}): SubagentTargetResolution;
