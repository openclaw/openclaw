import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { StatusSummary } from "./status.types.js";
export type LocalTuiProcess = {
    pid: number;
    command: string;
};
type ProcessSignal = "SIGTERM" | "SIGKILL";
type ProcessController = {
    kill: (pid: number, signal: ProcessSignal | 0) => boolean;
};
export declare function listLocalTuiProcesses(): LocalTuiProcess[];
export declare function terminateLocalTuiProcesses(params: {
    processes: LocalTuiProcess[];
    controller?: ProcessController;
    graceMs?: number;
}): Promise<{
    stopped: number[];
    failed: number[];
}>;
export declare function noteWhatsappResponsivenessHealth(params: {
    cfg: OpenClawConfig;
    status?: Pick<StatusSummary, "eventLoop"> | null;
    shouldRepair: boolean;
    listLocalTuiProcesses?: () => LocalTuiProcess[];
    terminateLocalTuiProcesses?: typeof terminateLocalTuiProcesses;
}): Promise<void>;
export {};
