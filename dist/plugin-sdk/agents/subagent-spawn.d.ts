import { decodeStrictBase64 } from "./subagent-attachments.js";
export declare const SUBAGENT_SPAWN_MODES: readonly ["run", "session"];
export type SpawnSubagentMode = (typeof SUBAGENT_SPAWN_MODES)[number];
export declare const SUBAGENT_SPAWN_SANDBOX_MODES: readonly ["inherit", "require"];
export type SpawnSubagentSandboxMode = (typeof SUBAGENT_SPAWN_SANDBOX_MODES)[number];
export { decodeStrictBase64 };
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
    sandbox?: SpawnSubagentSandboxMode;
    expectsCompletionMessage?: boolean;
    attachments?: Array<{
        name: string;
        content: string;
        encoding?: "utf8" | "base64";
        mimeType?: string;
    }>;
    attachMountPath?: string;
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
    /** Explicit workspace directory for subagent to inherit (optional). */
    workspaceDir?: string;
};
export declare const SUBAGENT_SPAWN_ACCEPTED_NOTE = "Auto-announce is push-based. After spawning children, do NOT call sessions_list, sessions_history, exec sleep, or any polling tool. Wait for completion events to arrive as user messages, track expected child session keys, and only send your final answer after ALL expected completions arrive. If a child completion event arrives AFTER your final answer, reply ONLY with NO_REPLY.";
export declare const SUBAGENT_SPAWN_SESSION_ACCEPTED_NOTE = "thread-bound session stays active after this task; continue in-thread for follow-ups.";
export type SpawnSubagentResult = {
    status: "accepted" | "forbidden" | "error";
    childSessionKey?: string;
    runId?: string;
    mode?: SpawnSubagentMode;
    note?: string;
    modelApplied?: boolean;
    error?: string;
    attachments?: {
        count: number;
        totalBytes: number;
        files: Array<{
            name: string;
            bytes: number;
            sha256: string;
        }>;
        relDir: string;
    };
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
