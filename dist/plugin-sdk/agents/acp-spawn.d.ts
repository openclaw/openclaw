import type { OpenClawConfig } from "../config/config.js";
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
    sandboxed?: boolean;
};
export type SpawnAcpResult = {
    status: "accepted" | "forbidden" | "error";
    childSessionKey?: string;
    runId?: string;
    mode?: SpawnAcpMode;
    streamLogPath?: string;
    note?: string;
    error?: string;
};
export declare const ACP_SPAWN_ACCEPTED_NOTE = "initial ACP task queued in isolated session; follow-ups continue in the bound thread.";
export declare const ACP_SPAWN_SESSION_ACCEPTED_NOTE = "thread-bound ACP session stays active after this task; continue in-thread for follow-ups.";
export declare function resolveAcpSpawnRuntimePolicyError(params: {
    cfg: OpenClawConfig;
    requesterSessionKey?: string;
    requesterSandboxed?: boolean;
    sandbox?: SpawnAcpSandboxMode;
}): string | undefined;
export declare function spawnAcpDirect(params: SpawnAcpParams, ctx: SpawnAcpContext): Promise<SpawnAcpResult>;
