import type { DoctorPrompter } from "./doctor-prompter.js";
type ServiceRepairPolicy = "auto" | "external";
export declare const SERVICE_REPAIR_POLICY_ENV = "OPENCLAW_SERVICE_REPAIR_POLICY";
export declare const EXTERNAL_SERVICE_REPAIR_NOTE = "Gateway service is managed externally; skipped service install/start repair. Start or repair the gateway through your supervisor.";
export declare function resolveServiceRepairPolicy(env?: NodeJS.ProcessEnv): ServiceRepairPolicy;
export declare function isServiceRepairExternallyManaged(policy?: ServiceRepairPolicy): boolean;
export declare function confirmDoctorServiceRepair(prompter: DoctorPrompter, params: Parameters<DoctorPrompter["confirmRuntimeRepair"]>[0], policy?: ServiceRepairPolicy): Promise<boolean>;
export {};
