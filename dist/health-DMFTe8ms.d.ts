import { n as ConfigValidationIssue } from "./types.openclaw-BLF4DJTX.js";
import { a as HealthCheck, c as HealthFinding, l as HealthFindingSeverity, o as HealthCheckContext } from "./health-check-registry-DT6JBKTB.js";

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
export { registerCoreHealthChecks as a, configValidationIssuesToHealthFindings as i, exitCodeFromFindings as n, runDoctorLintChecks as r, DoctorLintRunOptions as t };