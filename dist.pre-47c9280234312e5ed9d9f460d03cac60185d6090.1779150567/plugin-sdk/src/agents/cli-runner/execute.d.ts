import { requestHeartbeat as requestHeartbeatImpl } from "../../infra/heartbeat-wake.js";
import { enqueueSystemEvent as enqueueSystemEventImpl } from "../../infra/system-events.js";
import { getProcessSupervisor as getProcessSupervisorImpl } from "../../process/supervisor/index.js";
import { type CliOutput } from "../cli-output.js";
import type { PreparedCliRunContext } from "./types.js";
declare const executeDeps: {
    getProcessSupervisor: typeof getProcessSupervisorImpl;
    enqueueSystemEvent: typeof enqueueSystemEventImpl;
    requestHeartbeat: typeof requestHeartbeatImpl;
};
export declare function setCliRunnerExecuteTestDeps(overrides: Partial<typeof executeDeps>): void;
export declare function buildCliExecLogLine(params: {
    provider: string;
    model: string;
    promptChars: number;
    trigger?: string;
    useResume: boolean;
    cliSessionId?: string;
    resolvedSessionId?: string;
    reusableSessionId?: string;
    invalidatedReason?: string;
    hasHistoryPrompt: boolean;
}): string;
export declare function buildCliEnvAuthLog(childEnv: Record<string, string>): string;
export declare function executePreparedCliRun(context: PreparedCliRunContext, cliSessionIdToUse?: string): Promise<CliOutput>;
export {};
