import type { NpmSpecResolution } from "./install-source-utils.js";
import type { ParsedRegistryNpmSpec } from "./npm-registry-spec.js";
export type ManagedNpmRootInstalledDependency = {
    version?: string;
    integrity?: string;
    resolved?: string;
};
export declare function resolveManagedNpmRootDependencySpec(params: {
    parsedSpec: ParsedRegistryNpmSpec;
    resolution: NpmSpecResolution;
}): string;
export declare function upsertManagedNpmRootDependency(params: {
    npmRoot: string;
    packageName: string;
    dependencySpec: string;
}): Promise<void>;
export declare function readManagedNpmRootInstalledDependency(params: {
    npmRoot: string;
    packageName: string;
}): Promise<ManagedNpmRootInstalledDependency | null>;
export declare function removeManagedNpmRootDependency(params: {
    npmRoot: string;
    packageName: string;
}): Promise<void>;
