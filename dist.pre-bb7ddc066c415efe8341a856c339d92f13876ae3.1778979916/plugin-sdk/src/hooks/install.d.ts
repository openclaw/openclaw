import { type NpmIntegrityDrift, type NpmSpecResolution } from "../infra/install-source-utils.js";
import type { InstallSafetyOverrides } from "../plugins/install-security-scan.js";
export type HookInstallLogger = {
    info?: (message: string) => void;
    warn?: (message: string) => void;
};
export type InstallHooksResult = {
    ok: true;
    hookPackId: string;
    hooks: string[];
    targetDir: string;
    version?: string;
    npmResolution?: NpmSpecResolution;
    integrityDrift?: NpmIntegrityDrift;
} | {
    ok: false;
    error: string;
};
export type HookNpmIntegrityDriftParams = {
    spec: string;
    expectedIntegrity: string;
    actualIntegrity: string;
    resolution: NpmSpecResolution;
};
type HookInstallForwardParams = InstallSafetyOverrides & {
    hooksDir?: string;
    timeoutMs?: number;
    logger?: HookInstallLogger;
    mode?: "install" | "update";
    dryRun?: boolean;
    expectedHookPackId?: string;
};
type HookArchiveInstallParams = {
    archivePath: string;
} & HookInstallForwardParams;
type HookPathInstallParams = {
    path: string;
} & HookInstallForwardParams;
export declare function resolveHookInstallDir(hookId: string, hooksDir?: string): string;
export declare function installHooksFromArchive(params: HookArchiveInstallParams): Promise<InstallHooksResult>;
export declare function installHooksFromNpmSpec(params: {
    spec: string;
    dangerouslyForceUnsafeInstall?: boolean;
    hooksDir?: string;
    timeoutMs?: number;
    logger?: HookInstallLogger;
    mode?: "install" | "update";
    dryRun?: boolean;
    expectedHookPackId?: string;
    expectedIntegrity?: string;
    onIntegrityDrift?: (params: HookNpmIntegrityDriftParams) => boolean | Promise<boolean>;
}): Promise<InstallHooksResult>;
export declare function installHooksFromPath(params: HookPathInstallParams): Promise<InstallHooksResult>;
export {};
