import type { AnchoredSandboxEntry, PathSafetyCheck } from "./fs-bridge-path-safety.js";
import type { SandboxResolvedFsPath } from "./fs-paths.js";
export type SandboxFsCommandPlan = {
    checks: PathSafetyCheck[];
    script: string;
    args?: string[];
    stdin?: Buffer | string;
    recheckBeforeCommand?: boolean;
    allowFailure?: boolean;
};
export declare function buildStatPlan(target: SandboxResolvedFsPath, anchoredTarget: AnchoredSandboxEntry): SandboxFsCommandPlan;
