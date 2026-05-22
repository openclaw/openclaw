import { runCommandWithTimeout } from "../process/exec.js";
import type { NpmSpecResolution } from "./install-source-utils.js";
import type { ParsedRegistryNpmSpec } from "./npm-registry-spec.js";
export type ManagedNpmRootInstalledDependency = {
    version?: string;
    integrity?: string;
    resolved?: string;
};
type ManagedNpmRootLogger = {
    warn?: (message: string) => void;
};
type ManagedNpmRootRunCommand = typeof runCommandWithTimeout;
export declare function readOpenClawManagedNpmRootOverrides(params?: {
    argv1?: string;
    cwd?: string;
    moduleUrl?: string;
    packageRoot?: string | null;
}): Promise<Record<string, unknown>>;
export declare function resolveManagedNpmRootDependencySpec(params: {
    parsedSpec: ParsedRegistryNpmSpec;
    resolution: NpmSpecResolution;
}): string;
export declare function upsertManagedNpmRootDependency(params: {
    npmRoot: string;
    packageName: string;
    dependencySpec: string;
    managedOverrides?: Record<string, unknown>;
}): Promise<void>;
export declare function repairManagedNpmRootOpenClawPeer(params: {
    npmRoot: string;
    timeoutMs?: number;
    logger?: ManagedNpmRootLogger;
    runCommand?: ManagedNpmRootRunCommand;
}): Promise<boolean>;
export declare function readManagedNpmRootInstalledDependency(params: {
    npmRoot: string;
    packageName: string;
}): Promise<ManagedNpmRootInstalledDependency | null>;
export declare function removeManagedNpmRootDependency(params: {
    npmRoot: string;
    packageName: string;
}): Promise<void>;
export {};
