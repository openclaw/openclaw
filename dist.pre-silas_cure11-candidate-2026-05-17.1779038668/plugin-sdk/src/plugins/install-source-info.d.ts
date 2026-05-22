import { type ParsedRegistryNpmSpec } from "../infra/npm-registry-spec.js";
import type { PluginPackageInstall } from "./manifest.js";
export type PluginInstallSourceWarning = "invalid-clawhub-spec" | "invalid-npm-spec" | "invalid-default-choice" | "default-choice-missing-source" | "clawhub-spec-floating" | "npm-integrity-without-source" | "npm-spec-floating" | "npm-spec-missing-integrity" | "npm-spec-package-name-mismatch";
export type PluginInstallNpmPinState = "exact-with-integrity" | "exact-without-integrity" | "floating-with-integrity" | "floating-without-integrity";
export type PluginInstallNpmSourceInfo = {
    spec: string;
    packageName: string;
    expectedPackageName?: string;
    selector?: string;
    selectorKind: ParsedRegistryNpmSpec["selectorKind"];
    exactVersion: boolean;
    expectedIntegrity?: string;
    pinState: PluginInstallNpmPinState;
};
export type PluginInstallLocalSourceInfo = {
    path: string;
};
export type PluginInstallClawHubSourceInfo = {
    spec: string;
    packageName: string;
    version?: string;
    exactVersion: boolean;
};
export type PluginInstallSourceInfo = {
    defaultChoice?: PluginPackageInstall["defaultChoice"];
    clawhub?: PluginInstallClawHubSourceInfo;
    npm?: PluginInstallNpmSourceInfo;
    local?: PluginInstallLocalSourceInfo;
    warnings: readonly PluginInstallSourceWarning[];
};
export type DescribePluginInstallSourceOptions = {
    expectedPackageName?: string | null;
};
export declare function describePluginInstallSource(install: PluginPackageInstall, options?: DescribePluginInstallSourceOptions): PluginInstallSourceInfo;
