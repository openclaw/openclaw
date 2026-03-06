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
export declare function collectCommandSecretAssignmentsFromSnapshot(params: {
    sourceConfig: OpenClawConfig;
    resolvedConfig: OpenClawConfig;
    commandName: string;
    targetIds: ReadonlySet<string>;
    inactiveRefPaths?: ReadonlySet<string>;
}): ResolveAssignmentsFromSnapshotResult;
