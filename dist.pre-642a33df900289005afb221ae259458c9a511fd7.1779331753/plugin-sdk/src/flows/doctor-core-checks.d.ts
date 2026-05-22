import type { ConfigValidationIssue } from "../config/types.openclaw.js";
import type { HealthCheck, HealthFinding } from "./health-checks.js";
export declare function configValidationIssuesToHealthFindings(issues: readonly ConfigValidationIssue[]): readonly HealthFinding[];
export declare function registerCoreHealthChecks(): void;
export declare function resetCoreHealthChecksForTest(): void;
export declare const CORE_HEALTH_CHECKS: readonly HealthCheck[];
