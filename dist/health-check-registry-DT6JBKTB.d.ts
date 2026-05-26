import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
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
//#region src/flows/health-check-registry.d.ts
declare function registerHealthCheck(check: HealthCheck): void;
declare function listHealthChecks(): readonly HealthCheck[];
declare function getHealthCheck(id: string): HealthCheck | undefined;
declare function clearHealthChecksForTest(): void;
//#endregion
export { HealthCheck as a, HealthFinding as c, HealthRepairDiff as d, HealthRepairEffect as f, parseHealthFindingSeverity as h, registerHealthCheck as i, HealthFindingSeverity as l, healthFindingMeetsSeverity as m, getHealthCheck as n, HealthCheckContext as o, HealthRepairResult as p, listHealthChecks as r, HealthCheckScope as s, clearHealthChecksForTest as t, HealthRepairContext as u };