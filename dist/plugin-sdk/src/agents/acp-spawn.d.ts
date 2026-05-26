import type { OpenClawConfig } from "../config/types.openclaw.js";
export declare const ACP_SPAWN_MODES: readonly ["run", "session"];
export type SpawnAcpMode = (typeof ACP_SPAWN_MODES)[number];
export declare const ACP_SPAWN_SANDBOX_MODES: readonly ["inherit", "require"];
export type SpawnAcpSandboxMode = (typeof ACP_SPAWN_SANDBOX_MODES)[number];
export declare const ACP_SPAWN_STREAM_TARGETS: readonly ["parent"];
export type SpawnAcpStreamTarget = (typeof ACP_SPAWN_STREAM_TARGETS)[number];
export type SpawnAcpParams = {
    task: string;
    label?: string;
    agentId?: string;
    resumeSessionId?: string;
    model?: string;
    thinking?: string;
    runTimeoutSeconds?: number;
    cwd?: string;
    mode?: SpawnAcpMode;
    thread?: boolean;
    sandbox?: SpawnAcpSandboxMode;
    streamTo?: SpawnAcpStreamTarget;
};
export type SpawnAcpContext = {
    agentSessionKey?: string;
    agentChannel?: string;
    agentAccountId?: string;
    agentTo?: string;
    agentThreadId?: string | number;
    /** Group chat ID for channels that distinguish group vs. topic (e.g. Telegram). */
    agentGroupId?: string;
    /** Group space label (guild/team id) from the originating channel context. */
    agentGroupSpace?: string | null;
    /** Trusted provider role ids for the requester in this group turn. */
    agentMemberRoleIds?: string[];
    sandboxed?: boolean;
};
export declare const ACP_SPAWN_ERROR_CODES: readonly ["acp_disabled", "requester_session_required", "runtime_policy", "resume_forbidden", "subagent_policy", "thread_required", "target_agent_required", "runtime_agent_mismatch", "agent_forbidden", "cwd_resolution_failed", "thread_binding_invalid", "spawn_failed", "dispatch_failed"];
export type SpawnAcpErrorCode = (typeof ACP_SPAWN_ERROR_CODES)[number];
type SpawnAcpResultFields = {
    childSessionKey?: string;
    runId?: string;
    mode?: SpawnAcpMode;
    inlineDelivery?: boolean;
    streamLogPath?: string;
    note?: string;
};
type SpawnAcpAcceptedResult = SpawnAcpResultFields & {
    status: "accepted";
    childSessionKey: string;
    runId: string;
    mode: SpawnAcpMode;
};
type SpawnAcpFailedResult = SpawnAcpResultFields & {
    status: "forbidden" | "error";
    error: string;
    errorCode: SpawnAcpErrorCode;
};
export type SpawnAcpResult = SpawnAcpAcceptedResult | SpawnAcpFailedResult;
export declare function isSpawnAcpAcceptedResult(result: SpawnAcpResult): result is SpawnAcpAcceptedResult;
export declare const ACP_SPAWN_ACCEPTED_NOTE = "initial ACP task queued in isolated session; follow-ups continue in the bound thread.";
export declare const ACP_SPAWN_SESSION_ACCEPTED_NOTE = "thread-bound ACP session stays active after this task; continue in-thread for follow-ups.";
export declare function resolveAcpSpawnRuntimePolicyError(params: {
    cfg: OpenClawConfig;
    requesterSessionKey?: string;
    requesterSandboxed?: boolean;
    sandbox?: SpawnAcpSandboxMode;
}): string | undefined;
export declare function spawnAcpDirect(params: SpawnAcpParams, ctx: SpawnAcpContext): Promise<SpawnAcpResult>;
export {};
