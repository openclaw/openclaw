import { callGateway, getRuntimeConfig } from "./subagent-announce.runtime.js";
import { readLatestAssistantReply } from "./tools/agent-step.js";
type SubagentAnnounceOutputDeps = {
    callGateway: typeof callGateway;
    getRuntimeConfig: typeof getRuntimeConfig;
    readLatestAssistantReply: typeof readLatestAssistantReply;
};
type AgentWaitResult = {
    status?: string;
    startedAt?: number;
    endedAt?: number;
    error?: string;
    stopReason?: string;
    livenessState?: string;
    yielded?: boolean;
};
export type SubagentRunOutcome = {
    status: "ok" | "error" | "timeout" | "unknown";
    error?: string;
    startedAt?: number;
    endedAt?: number;
    elapsedMs?: number;
};
export declare function withSubagentOutcomeTiming(outcome: SubagentRunOutcome, timing: {
    startedAt?: number;
    endedAt?: number;
}): SubagentRunOutcome;
export declare function readSubagentOutput(sessionKey: string, outcome?: SubagentRunOutcome): Promise<string | undefined>;
export declare function readLatestSubagentOutputWithRetry(params: {
    sessionKey: string;
    maxWaitMs: number;
    outcome?: SubagentRunOutcome;
}): Promise<string | undefined>;
export declare function waitForSubagentRunOutcome(runId: string, timeoutMs: number): Promise<AgentWaitResult>;
export declare function applySubagentWaitOutcome(params: {
    wait: AgentWaitResult | undefined;
    outcome: SubagentRunOutcome | undefined;
    startedAt?: number;
    endedAt?: number;
}): {
    outcome: SubagentRunOutcome | undefined;
    startedAt: number | undefined;
    endedAt: number | undefined;
};
export declare function captureSubagentCompletionReply(sessionKey: string, options?: {
    waitForReply?: boolean;
    outcome?: SubagentRunOutcome;
}): Promise<string | undefined>;
export declare function buildChildCompletionFindings(children: Array<{
    childSessionKey: string;
    task: string;
    label?: string;
    createdAt: number;
    endedAt?: number;
    frozenResultText?: string | null;
    outcome?: SubagentRunOutcome;
}>): string | undefined;
export declare function dedupeLatestChildCompletionRows(children: Array<{
    childSessionKey: string;
    task: string;
    label?: string;
    createdAt: number;
    endedAt?: number;
    frozenResultText?: string | null;
    outcome?: SubagentRunOutcome;
}>): {
    childSessionKey: string;
    task: string;
    label?: string;
    createdAt: number;
    endedAt?: number;
    frozenResultText?: string | null;
    outcome?: SubagentRunOutcome;
}[];
export declare function filterCurrentDirectChildCompletionRows(children: Array<{
    runId: string;
    childSessionKey: string;
    requesterSessionKey: string;
    task: string;
    label?: string;
    createdAt: number;
    endedAt?: number;
    frozenResultText?: string | null;
    outcome?: SubagentRunOutcome;
}>, params: {
    requesterSessionKey: string;
    getLatestSubagentRunByChildSessionKey?: (childSessionKey: string) => {
        runId: string;
        requesterSessionKey: string;
    } | null | undefined;
}): {
    runId: string;
    childSessionKey: string;
    requesterSessionKey: string;
    task: string;
    label?: string;
    createdAt: number;
    endedAt?: number;
    frozenResultText?: string | null;
    outcome?: SubagentRunOutcome;
}[];
export declare function buildCompactAnnounceStatsLine(params: {
    sessionKey: string;
    startedAt?: number;
    endedAt?: number;
}): Promise<string>;
export declare const __testing: {
    setDepsForTest(overrides?: Partial<SubagentAnnounceOutputDeps>): void;
};
export {};
