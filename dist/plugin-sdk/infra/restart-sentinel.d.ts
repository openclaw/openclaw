export type RestartSentinelLog = {
    stdoutTail?: string | null;
    stderrTail?: string | null;
    exitCode?: number | null;
};
export type RestartSentinelStep = {
    name: string;
    command: string;
    cwd?: string | null;
    durationMs?: number | null;
    log?: RestartSentinelLog | null;
};
export type RestartSentinelStats = {
    mode?: string;
    root?: string;
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
    steps?: RestartSentinelStep[];
    reason?: string | null;
    durationMs?: number | null;
};
export type RestartSentinelPayload = {
    kind: "config-apply" | "config-patch" | "update" | "restart";
    status: "ok" | "error" | "skipped";
    ts: number;
    sessionKey?: string;
    /** Delivery context captured at restart time to ensure channel routing survives restart. */
    deliveryContext?: {
        channel?: string;
        to?: string;
        accountId?: string;
    };
    /** Thread ID for reply threading (e.g., Slack thread_ts). */
    threadId?: string;
    message?: string | null;
    doctorHint?: string | null;
    stats?: RestartSentinelStats | null;
};
export type RestartSentinel = {
    version: 1;
    payload: RestartSentinelPayload;
};
export declare function formatDoctorNonInteractiveHint(env?: Record<string, string | undefined>): string;
export declare function resolveRestartSentinelPath(env?: NodeJS.ProcessEnv): string;
export declare function writeRestartSentinel(payload: RestartSentinelPayload, env?: NodeJS.ProcessEnv): Promise<string>;
export declare function readRestartSentinel(env?: NodeJS.ProcessEnv): Promise<RestartSentinel | null>;
export declare function consumeRestartSentinel(env?: NodeJS.ProcessEnv): Promise<RestartSentinel | null>;
export declare function formatRestartSentinelMessage(payload: RestartSentinelPayload): string;
export declare function summarizeRestartSentinel(payload: RestartSentinelPayload): string;
export declare function trimLogTail(input?: string | null, maxChars?: number): string | null;
