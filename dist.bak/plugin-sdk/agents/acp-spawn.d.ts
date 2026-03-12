export declare const ACP_SPAWN_MODES: readonly ["run", "session"];
export type SpawnAcpMode = (typeof ACP_SPAWN_MODES)[number];
export type SpawnAcpParams = {
    task: string;
    label?: string;
    agentId?: string;
    cwd?: string;
    mode?: SpawnAcpMode;
    thread?: boolean;
};
export type SpawnAcpContext = {
    agentSessionKey?: string;
    agentChannel?: string;
    agentAccountId?: string;
    agentTo?: string;
    agentThreadId?: string | number;
};
export type SpawnAcpResult = {
    status: "accepted" | "forbidden" | "error";
    childSessionKey?: string;
    runId?: string;
    mode?: SpawnAcpMode;
    note?: string;
    error?: string;
};
export declare const ACP_SPAWN_ACCEPTED_NOTE = "initial ACP task queued in isolated session; follow-ups continue in the bound thread.";
export declare const ACP_SPAWN_SESSION_ACCEPTED_NOTE = "thread-bound ACP session stays active after this task; continue in-thread for follow-ups.";
export declare function spawnAcpDirect(params: SpawnAcpParams, ctx: SpawnAcpContext): Promise<SpawnAcpResult>;
