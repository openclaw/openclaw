import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HealthCheck, HealthFinding, HealthRepairContext, HealthRepairDiff, HealthRepairEffect } from "./health-checks.js";
export interface DoctorRepairRunOptions {
    readonly checks?: readonly HealthCheck[];
    readonly dryRun?: boolean;
    readonly diff?: boolean;
}
export interface DoctorRepairRunResult {
    readonly config: OpenClawConfig;
    readonly findings: readonly HealthFinding[];
    readonly remainingFindings: readonly HealthFinding[];
    readonly changes: readonly string[];
    readonly warnings: readonly string[];
    readonly diffs: readonly HealthRepairDiff[];
    readonly effects: readonly HealthRepairEffect[];
    readonly checksRun: number;
    readonly checksRepaired: number;
    readonly checksValidated: number;
}
export declare function runDoctorHealthRepairs(ctx: HealthRepairContext, opts?: DoctorRepairRunOptions): Promise<DoctorRepairRunResult>;
