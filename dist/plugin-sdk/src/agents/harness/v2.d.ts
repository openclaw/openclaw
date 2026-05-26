import type { AgentHarness, AgentHarnessAttemptParams, AgentHarnessAttemptResult, AgentHarnessCompactParams, AgentHarnessCompactResult, AgentHarnessResetParams, AgentHarnessSupport, AgentHarnessSupportContext } from "./types.js";
type AgentHarnessV2RunBase = {
    harnessId: string;
    label: string;
    pluginId?: string;
    params: AgentHarnessAttemptParams;
};
export type AgentHarnessV2PreparedRun = AgentHarnessV2RunBase & {
    lifecycleState: "prepared";
};
export type AgentHarnessV2Session = AgentHarnessV2RunBase & {
    lifecycleState: "started";
};
export type AgentHarnessV2ToolCall = {
    id?: string;
    name: string;
    input?: unknown;
};
export type AgentHarnessV2CleanupParams = {
    prepared?: AgentHarnessV2PreparedRun;
    session?: AgentHarnessV2Session;
    result?: AgentHarnessAttemptResult;
    error?: unknown;
};
export type AgentHarnessV2 = {
    id: string;
    label: string;
    pluginId?: string;
    supports(ctx: AgentHarnessSupportContext): AgentHarnessSupport;
    prepare(params: AgentHarnessAttemptParams): Promise<AgentHarnessV2PreparedRun>;
    start(prepared: AgentHarnessV2PreparedRun): Promise<AgentHarnessV2Session>;
    resume?(session: AgentHarnessV2Session): Promise<AgentHarnessV2Session>;
    send(session: AgentHarnessV2Session): Promise<AgentHarnessAttemptResult>;
    handleToolCall?(session: AgentHarnessV2Session, call: AgentHarnessV2ToolCall): Promise<unknown>;
    resolveOutcome(session: AgentHarnessV2Session, result: AgentHarnessAttemptResult): Promise<AgentHarnessAttemptResult>;
    cleanup(params: AgentHarnessV2CleanupParams): Promise<void>;
    compact?(params: AgentHarnessCompactParams): Promise<AgentHarnessCompactResult | undefined>;
    reset?(params: AgentHarnessResetParams): Promise<void> | void;
    dispose?(): Promise<void> | void;
};
export declare function adaptAgentHarnessToV2(harness: AgentHarness): AgentHarnessV2;
export declare function runAgentHarnessV2LifecycleAttempt(harness: AgentHarnessV2, params: AgentHarnessAttemptParams): Promise<AgentHarnessAttemptResult>;
export {};
