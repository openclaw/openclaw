export declare const SUPERVISOR_HINT_ENV_VARS: readonly ["LAUNCH_JOB_LABEL", "LAUNCH_JOB_NAME", "XPC_SERVICE_NAME", "OPENCLAW_LAUNCHD_LABEL", "OPENCLAW_SYSTEMD_UNIT", "INVOCATION_ID", "SYSTEMD_EXEC_PID", "JOURNAL_STREAM", "OPENCLAW_WINDOWS_TASK_NAME", "OPENCLAW_SERVICE_MARKER", "OPENCLAW_SERVICE_KIND"];
export type RespawnSupervisor = "launchd" | "systemd" | "schtasks";
export declare function detectRespawnSupervisor(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): RespawnSupervisor | null;
