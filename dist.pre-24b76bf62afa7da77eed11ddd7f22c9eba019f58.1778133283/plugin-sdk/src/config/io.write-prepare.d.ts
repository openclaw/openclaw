import type { OpenClawConfig } from "./types.js";
export declare function createMergePatch(base: unknown, target: unknown): unknown;
export declare function projectSourceOntoRuntimeShape(source: unknown, runtime: unknown): unknown;
export declare function resolvePersistCandidateForWrite(params: {
    runtimeConfig: unknown;
    sourceConfig: unknown;
    nextConfig: unknown;
    rootAuthoredConfig?: unknown;
    unsetPaths?: readonly string[][];
}): unknown;
export declare function formatConfigValidationFailure(pathLabel: string, issueMessage: string): string;
export declare function unsetPathForWrite(root: OpenClawConfig, pathSegments: string[]): {
    changed: boolean;
    next: OpenClawConfig;
};
export declare function applyUnsetPathsForWrite(root: OpenClawConfig, unsetPaths: readonly string[][] | undefined): OpenClawConfig;
export declare function resolveManagedUnsetPathsForWrite(unsetPaths: readonly string[][] | undefined): string[][];
export declare function collectChangedPaths(base: unknown, target: unknown, path: string, output: Set<string>): void;
export declare function restoreEnvRefsFromMap(value: unknown, path: string, envRefMap: Map<string, string>, changedPaths: Set<string>): unknown;
export declare function resolveWriteEnvSnapshotForPath(params: {
    actualConfigPath: string;
    expectedConfigPath?: string;
    envSnapshotForRestore?: Record<string, string | undefined>;
}): Record<string, string | undefined> | undefined;
