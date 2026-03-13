import type { OpenClawConfig } from "../config/config.js";
export type CommandSecretAssignment = {
    path: string;
    pathSegments: string[];
    value: unknown;
};
export type ResolveAssignmentsFromSnapshotResult = {
    assignments: CommandSecretAssignment[];
    diagnostics: string[];
};
export type UnresolvedCommandSecretAssignment = {
    path: string;
    pathSegments: string[];
};
export type AnalyzeAssignmentsFromSnapshotResult = {
    assignments: CommandSecretAssignment[];
    diagnostics: string[];
    unresolved: UnresolvedCommandSecretAssignment[];
    inactive: UnresolvedCommandSecretAssignment[];
};
export declare function analyzeCommandSecretAssignmentsFromSnapshot(params: {
    sourceConfig: OpenClawConfig;
    resolvedConfig: OpenClawConfig;
    targetIds: ReadonlySet<string>;
    inactiveRefPaths?: ReadonlySet<string>;
    allowedPaths?: ReadonlySet<string>;
}): AnalyzeAssignmentsFromSnapshotResult;
export declare function collectCommandSecretAssignmentsFromSnapshot(params: {
    sourceConfig: OpenClawConfig;
    resolvedConfig: OpenClawConfig;
    commandName: string;
    targetIds: ReadonlySet<string>;
    inactiveRefPaths?: ReadonlySet<string>;
    allowedPaths?: ReadonlySet<string>;
}): ResolveAssignmentsFromSnapshotResult;
