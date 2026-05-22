import type { InstallSafetyOverrides } from "./install-security-scan.js";
import { type InstallPluginResult } from "./install.js";
type PluginInstallLogger = {
    info?: (message: string) => void;
    warn?: (message: string) => void;
};
export type GitPluginResolution = {
    url: string;
    ref?: string;
    commit?: string;
    resolvedAt: string;
};
export type GitPluginInstallResult = (Extract<InstallPluginResult, {
    ok: true;
}> & {
    git: GitPluginResolution;
}) | Extract<InstallPluginResult, {
    ok: false;
}>;
export type ParsedGitPluginSpec = {
    input: string;
    url: string;
    ref?: string;
    label: string;
    normalizedSpec: string;
};
export declare function parseGitPluginSpec(raw: string): ParsedGitPluginSpec | null;
export declare function installPluginFromGitSpec(params: InstallSafetyOverrides & {
    spec: string;
    extensionsDir?: string;
    gitDir?: string;
    timeoutMs?: number;
    logger?: PluginInstallLogger;
    mode?: "install" | "update";
    dryRun?: boolean;
    expectedPluginId?: string;
}): Promise<GitPluginInstallResult>;
export {};
