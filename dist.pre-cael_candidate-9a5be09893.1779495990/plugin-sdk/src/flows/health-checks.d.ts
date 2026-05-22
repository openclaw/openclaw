import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
export type HealthFindingSeverity = "info" | "warning" | "error";
export declare const HEALTH_FINDING_SEVERITY_RANK: Record<HealthFindingSeverity, number>;
export declare function parseHealthFindingSeverity(input: string | undefined): HealthFindingSeverity | null;
export declare function healthFindingMeetsSeverity(finding: Pick<HealthFinding, "severity">, severityMin: HealthFindingSeverity): boolean;
export interface HealthFinding {
    readonly checkId: string;
    readonly severity: HealthFindingSeverity;
    readonly message: string;
    readonly source?: string;
    readonly path?: string;
    readonly line?: number;
    readonly column?: number;
    readonly ocPath?: string;
    readonly target?: string;
    readonly requirement?: string;
    readonly fixHint?: string;
}
export type HealthCheckMode = "doctor" | "lint" | "fix";
export interface HealthCheckContext {
    readonly mode: HealthCheckMode;
    readonly runtime: RuntimeEnv;
    readonly cfg: OpenClawConfig;
    readonly cwd?: string;
    readonly configPath?: string;
}
export interface HealthRepairContext extends Omit<HealthCheckContext, "mode"> {
    readonly mode: "fix";
    readonly dryRun?: boolean;
    readonly diff?: boolean;
}
export interface HealthRepairDiff {
    readonly kind: "config" | "file";
    readonly path: string;
    readonly before?: string;
    readonly after?: string;
    readonly unifiedDiff?: string;
}
export interface HealthRepairEffect {
    readonly kind: "config" | "file" | "service" | "process" | "package" | "state" | "other";
    readonly action: string;
    readonly target?: string;
    readonly dryRunSafe?: boolean;
}
export interface HealthRepairResult {
    readonly status?: "repaired" | "skipped" | "failed";
    readonly reason?: string;
    readonly config?: OpenClawConfig;
    readonly changes: readonly string[];
    readonly warnings?: readonly string[];
    readonly diffs?: readonly HealthRepairDiff[];
    readonly effects?: readonly HealthRepairEffect[];
}
export interface HealthCheckScope {
    readonly findings?: readonly HealthFinding[];
    readonly paths?: readonly string[];
    readonly ocPaths?: readonly string[];
}
export interface HealthCheck {
    readonly id: string;
    readonly kind: "core" | "plugin";
    readonly description: string;
    readonly source?: string;
    detect(ctx: HealthCheckContext, scope?: HealthCheckScope): Promise<readonly HealthFinding[]>;
    repair?(ctx: HealthRepairContext, findings: readonly HealthFinding[]): Promise<HealthRepairResult>;
}
