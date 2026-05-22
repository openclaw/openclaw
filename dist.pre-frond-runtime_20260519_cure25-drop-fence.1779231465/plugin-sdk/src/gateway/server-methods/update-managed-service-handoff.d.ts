import type { UpdateRestartSentinelMeta } from "../../infra/update-restart-sentinel-payload.js";
export type ManagedServiceUpdateHandoffResult = {
    status: "started";
    pid?: number;
    command: string;
    logPath: string;
};
export declare function formatManagedServiceUpdateCommand(timeoutMs?: number): string;
export declare function stripSupervisorHintEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export declare function startManagedServiceUpdateHandoff(params: {
    root: string;
    timeoutMs?: number;
    restartDelayMs?: number;
    meta: UpdateRestartSentinelMeta;
    handoffId?: string;
    env?: NodeJS.ProcessEnv;
    execPath?: string;
    argv1?: string;
    parentPid?: number;
}): Promise<ManagedServiceUpdateHandoffResult>;
export declare function buildManagedServiceHandoffUnavailableMessage(command: string): string;
