import type { SkillStatusEntry } from "../agents/skills-status.js";
import type { ConfigValidationIssue, OpenClawConfig } from "../config/types.openclaw.js";
import type { HealthCheck, HealthFinding } from "./health-checks.js";
export type CoreHealthCheckDeps = {
    readonly detectUnavailableSkills: (cfg: OpenClawConfig) => Promise<readonly SkillStatusEntry[]>;
    readonly collectSecurityWarnings: (cfg: OpenClawConfig) => Promise<readonly string[]>;
    readonly collectWorkspaceSuggestionNotes: (workspaceDir: string) => Promise<readonly string[]>;
};
export declare function configValidationIssuesToHealthFindings(issues: readonly ConfigValidationIssue[]): readonly HealthFinding[];
export declare function registerCoreHealthChecks(): void;
export declare function resetCoreHealthChecksForTest(): void;
export declare function createCoreHealthChecks(deps?: CoreHealthCheckDeps): readonly HealthCheck[];
export declare const CORE_HEALTH_CHECKS: readonly HealthCheck[];
