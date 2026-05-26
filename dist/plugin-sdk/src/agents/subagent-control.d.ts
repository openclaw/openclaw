import type { ClearSessionQueueResult } from "../auto-reply/reply/queue.js";
import { type SubagentTargetResolution } from "../auto-reply/reply/subagents-utils.js";
import { updateSessionStore } from "../config/sessions/store.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { callGateway } from "../gateway/call.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
export declare const DEFAULT_RECENT_MINUTES = 30;
export declare const MAX_RECENT_MINUTES: number;
export declare const MAX_STEER_MESSAGE_CHARS = 4000;
type GatewayCaller = typeof callGateway;
type UpdateSessionStore = typeof updateSessionStore;
type AbortEmbeddedPiRun = (sessionId: string) => boolean;
type ClearSessionQueues = (keys: Array<string | undefined>) => ClearSessionQueueResult;
export type ResolvedSubagentController = {
    controllerSessionKey: string;
    callerSessionKey: string;
    callerIsSubagent: boolean;
    controlScope: "children" | "none";
};
export declare function resolveSubagentController(params: {
    cfg: OpenClawConfig;
    agentSessionKey?: string;
}): ResolvedSubagentController;
export declare function listControlledSubagentRuns(controllerSessionKey: string): SubagentRunRecord[];
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
    error?: undefined;
    status: "ok";
    killed: number;
    labels: string[];
}>;
export declare function killControlledSubagentRun(params: {
    cfg: OpenClawConfig;
    controller: ResolvedSubagentController;
    entry: SubagentRunRecord;
}): Promise<{
    label?: undefined;
    text?: undefined;
    status: "forbidden";
    runId: string;
    sessionKey: string;
    error: string;
    cascadeKilled?: undefined;
    cascadeLabels?: undefined;
} | {
    error?: undefined;
    status: "done";
    runId: string;
    sessionKey: string;
    label: string;
    text: string;
    cascadeKilled?: undefined;
    cascadeLabels?: undefined;
} | {
    error?: undefined;
    status: "ok";
    runId: string;
    sessionKey: string;
    label: string;
    cascadeKilled: number;
    cascadeLabels: string[] | undefined;
    text: string;
}>;
export declare function killSubagentRunAdmin(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
}): Promise<{
    sessionKey?: undefined;
    cascadeKilled?: undefined;
    cascadeLabels?: undefined;
    found: false;
    killed: boolean;
    runId?: undefined;
} | {
    found: true;
    killed: boolean;
    runId: string;
    sessionKey: string;
    cascadeKilled: number;
    cascadeLabels: string[] | undefined;
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
    controller: ResolvedSubagentController;
    entry: SubagentRunRecord;
    message: string;
}): Promise<{
    text?: undefined;
    runId?: undefined;
    status: "forbidden";
    error: string;
    replyText?: undefined;
} | {
    error?: undefined;
    status: "done";
    runId: string;
    text: string;
    replyText?: undefined;
} | {
    error?: undefined;
    text?: undefined;
    status: "timeout";
    runId: string;
    replyText?: undefined;
} | {
    text?: undefined;
    status: "error";
    runId: string;
    error: string;
    replyText?: undefined;
} | {
    error?: undefined;
    text?: undefined;
    status: "ok";
    runId: string;
    replyText: string | undefined;
}>;
export declare function resolveControlledSubagentTarget(runs: SubagentRunRecord[], token: string | undefined, options?: {
    recentMinutes?: number;
    isActive?: (entry: SubagentRunRecord) => boolean;
}): SubagentTargetResolution;
export declare const __testing: {
    setDepsForTest(overrides?: Partial<{
        callGateway: GatewayCaller;
        updateSessionStore: UpdateSessionStore;
        abortEmbeddedPiRun: AbortEmbeddedPiRun;
        clearSessionQueues: ClearSessionQueues;
    }>): void;
};
export {};
