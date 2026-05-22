import { i as OpenClawConfig, n as ConfigValidationIssue } from "./types.openclaw-GamulG8g.js";
import { n as RuntimeEnv } from "./runtime-Bxifh4bY.js";

//#region src/flows/health-checks.d.ts
type HealthFindingSeverity = "info" | "warning" | "error";
declare function parseHealthFindingSeverity(input: string | undefined): HealthFindingSeverity | null;
declare function healthFindingMeetsSeverity(finding: Pick<HealthFinding, "severity">, severityMin: HealthFindingSeverity): boolean;
interface HealthFinding {
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
type HealthCheckMode = "doctor" | "lint" | "fix";
interface HealthCheckContext {
  readonly mode: HealthCheckMode;
  readonly runtime: RuntimeEnv;
  readonly cfg: OpenClawConfig;
  readonly cwd?: string;
  readonly configPath?: string;
}
interface HealthRepairContext extends Omit<HealthCheckContext, "mode"> {
  readonly mode: "fix";
  readonly dryRun?: boolean;
  readonly diff?: boolean;
}
interface HealthRepairDiff {
  readonly kind: "config" | "file";
  readonly path: string;
  readonly before?: string;
  readonly after?: string;
  readonly unifiedDiff?: string;
}
interface HealthRepairEffect {
  readonly kind: "config" | "file" | "service" | "process" | "package" | "state" | "other";
  readonly action: string;
  readonly target?: string;
  readonly dryRunSafe?: boolean;
}
interface HealthRepairResult {
  readonly status?: "repaired" | "skipped" | "failed";
  readonly reason?: string;
  readonly config?: OpenClawConfig;
  readonly changes: readonly string[];
  readonly warnings?: readonly string[];
  readonly diffs?: readonly HealthRepairDiff[];
  readonly effects?: readonly HealthRepairEffect[];
}
interface HealthCheckScope {
  readonly findings?: readonly HealthFinding[];
  readonly paths?: readonly string[];
  readonly ocPaths?: readonly string[];
}
interface HealthCheck {
  readonly id: string;
  readonly kind: "core" | "plugin";
  readonly description: string;
  readonly source?: string;
  detect(ctx: HealthCheckContext, scope?: HealthCheckScope): Promise<readonly HealthFinding[]>;
  repair?(ctx: HealthRepairContext, findings: readonly HealthFinding[]): Promise<HealthRepairResult>;
}
//#endregion
//#region src/flows/doctor-core-checks.d.ts
declare function configValidationIssuesToHealthFindings(issues: readonly ConfigValidationIssue[]): readonly HealthFinding[];
declare function registerCoreHealthChecks(): void;
//#endregion
//#region src/flows/doctor-lint-flow.d.ts
interface DoctorLintRunOptions {
  readonly checks?: readonly HealthCheck[];
  readonly skipIds?: ReadonlySet<string> | readonly string[];
  readonly onlyIds?: ReadonlySet<string> | readonly string[];
}
interface DoctorLintRunResult {
  readonly findings: readonly HealthFinding[];
  readonly checksRun: number;
  readonly checksSkipped: number;
}
declare function runDoctorLintChecks(ctx: HealthCheckContext, opts?: DoctorLintRunOptions): Promise<DoctorLintRunResult>;
declare function exitCodeFromFindings(findings: readonly HealthFinding[], severityMin?: HealthFindingSeverity): 0 | 1;
//#endregion
//#region src/flows/health-check-registry.d.ts
declare function registerHealthCheck(check: HealthCheck): void;
declare function listHealthChecks(): readonly HealthCheck[];
declare function getHealthCheck(id: string): HealthCheck | undefined;
//#endregion
export { HealthRepairResult as _, exitCodeFromFindings as a, registerCoreHealthChecks as c, HealthCheckScope as d, HealthFinding as f, HealthRepairEffect as g, HealthRepairDiff as h, DoctorLintRunOptions as i, HealthCheck as l, HealthRepairContext as m, listHealthChecks as n, runDoctorLintChecks as o, HealthFindingSeverity as p, registerHealthCheck as r, configValidationIssuesToHealthFindings as s, getHealthCheck as t, HealthCheckContext as u, healthFindingMeetsSeverity as v, parseHealthFindingSeverity as y };