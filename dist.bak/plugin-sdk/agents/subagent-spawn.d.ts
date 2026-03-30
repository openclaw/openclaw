export declare const SUBAGENT_SPAWN_MODES: readonly ["run", "session"];
export type SpawnSubagentMode = (typeof SUBAGENT_SPAWN_MODES)[number];
export type SpawnSubagentParams = {
    task: string;
    label?: string;
    agentId?: string;
    model?: string;
    thinking?: string;
    runTimeoutSeconds?: number;
    thread?: boolean;
    mode?: SpawnSubagentMode;
    cleanup?: "delete" | "keep";
    expectsCompletionMessage?: boolean;
};
export type SpawnSubagentContext = {
    agentSessionKey?: string;
    agentChannel?: string;
    agentAccountId?: string;
    agentTo?: string;
    agentThreadId?: string | number;
    agentGroupId?: string | null;
    agentGroupChannel?: string | null;
    agentGroupSpace?: string | null;
    requesterAgentIdOverride?: string;
};
export declare const SUBAGENT_SPAWN_ACCEPTED_NOTE = "auto-announces on completion, do not poll/sleep. The response will be sent back as an user message.";
export declare const SUBAGENT_SPAWN_SESSION_ACCEPTED_NOTE = "thread-bound session stays active after this task; continue in-thread for follow-ups.";
export type SpawnSubagentResult = {
    status: "accepted" | "forbidden" | "error";
    childSessionKey?: string;
    runId?: string;
    mode?: SpawnSubagentMode;
    note?: string;
    modelApplied?: boolean;
    error?: string;
};
export declare function splitModelRef(ref?: string): {
    provider: undefined;
    model: undefined;
} | {
    provider: string;
    model: string;
} | {
    provider: undefined;
    model: string;
};
export declare function spawnSubagentDirect(params: SpawnSubagentParams, ctx: SpawnSubagentContext): Promise<SpawnSubagentResult>;
