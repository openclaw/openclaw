import { callGateway } from "../gateway/call.js";
type GatewayCaller = typeof callGateway;
export type AssistantReplySnapshot = {
    text?: string;
    fingerprint?: string;
};
export type AgentWaitResult = {
    status: "ok" | "timeout" | "error" | "pending";
    error?: string;
    startedAt?: number;
    endedAt?: number;
    stopReason?: string;
    livenessState?: string;
    yielded?: boolean;
};
export type AgentRunsDrainResult = {
    timedOut: boolean;
    pendingRunIds: string[];
    deadlineAtMs: number;
};
export declare function isRecoverableAgentWaitError(error: string | undefined): boolean;
export declare function readLatestAssistantReplySnapshot(params: {
    sessionKey: string;
    limit?: number;
    callGateway?: GatewayCaller;
}): Promise<AssistantReplySnapshot>;
export declare function readLatestAssistantReply(params: {
    sessionKey: string;
    limit?: number;
    callGateway?: GatewayCaller;
}): Promise<string | undefined>;
export declare function waitForAgentRun(params: {
    runId: string;
    timeoutMs: number;
    callGateway?: GatewayCaller;
}): Promise<AgentWaitResult>;
export declare function waitForAgentRunAndReadUpdatedAssistantReply(params: {
    runId: string;
    sessionKey: string;
    timeoutMs: number;
    limit?: number;
    baseline?: AssistantReplySnapshot;
    callGateway?: GatewayCaller;
}): Promise<AgentWaitResult & {
    replyText?: string;
}>;
export declare function waitForAgentRunsToDrain(params: {
    getPendingRunIds: () => Iterable<string>;
    initialPendingRunIds?: Iterable<string>;
    timeoutMs?: number;
    deadlineAtMs?: number;
    callGateway?: GatewayCaller;
}): Promise<AgentRunsDrainResult>;
export declare const __testing: {
    setDepsForTest(overrides?: Partial<{
        callGateway: GatewayCaller;
    }>): void;
};
export {};
