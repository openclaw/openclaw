import type { ProcessSupervisor } from "./types.js";
export declare function getProcessSupervisor(): ProcessSupervisor;
export { createProcessSupervisor } from "./supervisor.js";
export type { ManagedRun, ProcessSupervisor, RunExit, RunRecord, RunState, SpawnInput, SpawnMode, TerminationReason, } from "./types.js";
