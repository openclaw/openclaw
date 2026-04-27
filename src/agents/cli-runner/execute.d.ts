import { requestHeartbeatNow as requestHeartbeatNowImpl } from "../../infra/heartbeat-wake.js";
import { enqueueSystemEvent as enqueueSystemEventImpl } from "../../infra/system-events.js";
import { getProcessSupervisor as getProcessSupervisorImpl } from "../../process/supervisor/index.js";
import { type CliOutput } from "../cli-output.js";
import type { PreparedCliRunContext } from "./types.js";
declare const executeDeps: {
    getProcessSupervisor: typeof getProcessSupervisorImpl;
    enqueueSystemEvent: typeof enqueueSystemEventImpl;
    requestHeartbeatNow: typeof requestHeartbeatNowImpl;
};
export declare function setCliRunnerExecuteTestDeps(overrides: Partial<typeof executeDeps>): void;
export declare function buildCliEnvAuthLog(childEnv: Record<string, string>): string;
export declare function executePreparedCliRun(context: PreparedCliRunContext, cliSessionIdToUse?: string): Promise<CliOutput>;
export {};
