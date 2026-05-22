import { type NpmIntegrityDrift, type NpmSpecResolution } from "../infra/install-source-utils.js";
import type { InstallSafetyOverrides } from "./install-security-scan.js";
export { resolvePluginInstallDir } from "./install-paths.js";
type PluginInstallLogger = {
    info?: (message: string) => void;
    warn?: (message: string) => void;
};
export declare const PLUGIN_INSTALL_ERROR_CODE: {
    readonly INVALID_NPM_SPEC: "invalid_npm_spec";
    readonly INVALID_MIN_HOST_VERSION: "invalid_min_host_version";
    readonly UNKNOWN_HOST_VERSION: "unknown_host_version";
    readonly INCOMPATIBLE_HOST_VERSION: "incompatible_host_version";
    readonly MISSING_OPENCLAW_EXTENSIONS: "missing_openclaw_extensions";
    readonly MISSING_PLUGIN_MANIFEST: "missing_plugin_manifest";
    readonly EMPTY_OPENCLAW_EXTENSIONS: "empty_openclaw_extensions";
    readonly INVALID_OPENCLAW_EXTENSIONS: "invalid_openclaw_extensions";
    readonly NPM_PACKAGE_NOT_FOUND: "npm_package_not_found";
    readonly PLUGIN_ID_MISMATCH: "plugin_id_mismatch";
    readonly SECURITY_SCAN_BLOCKED: "security_scan_blocked";
    readonly SECURITY_SCAN_FAILED: "security_scan_failed";
};
export type PluginInstallErrorCode = (typeof PLUGIN_INSTALL_ERROR_CODE)[keyof typeof PLUGIN_INSTALL_ERROR_CODE];
export type InstallPluginResult = {
    ok: true;
    pluginId: string;
    targetDir: string;
    manifestName?: string;
    version?: string;
    extensions: string[];
    npmResolution?: NpmSpecResolution;
    integrityDrift?: NpmIntegrityDrift;
} | {
    ok: false;
    error: string;
    code?: PluginInstallErrorCode;
};
export type PluginNpmIntegrityDriftParams = {
    spec: string;
    expectedIntegrity: string;
    actualIntegrity: string;
    resolution: NpmSpecResolution;
};
type PluginInstallPolicyRequest = {
    kind: "plugin-dir" | "plugin-archive" | "plugin-file" | "plugin-npm" | "plugin-git";
    requestedSpecifier?: string;
};
type PackageInstallCommonParams = InstallSafetyOverrides & {
    extensionsDir?: string;
    npmDir?: string;
    timeoutMs?: number;
    logger?: PluginInstallLogger;
    mode?: "install" | "update";
    dryRun?: boolean;
    expectedPluginId?: string;
    requirePluginManifest?: boolean;
    installPolicyRequest?: PluginInstallPolicyRequest;
};
export declare function installPluginFromInstalledPackageDir(params: {
    packageDir: string;
    dependencyScanRootDir?: string;
} & PackageInstallCommonParams): Promise<InstallPluginResult>;
export declare function installPluginFromArchive(params: {
    archivePath: string;
} & PackageInstallCommonParams): Promise<InstallPluginResult>;
export declare function installPluginFromDir(params: {
    dirPath: string;
} & PackageInstallCommonParams): Promise<InstallPluginResult>;
export declare function installPluginFromFile(params: {
    filePath: string;
    dangerouslyForceUnsafeInstall?: boolean;
    extensionsDir?: string;
    logger?: PluginInstallLogger;
    mode?: "install" | "update";
    dryRun?: boolean;
    installPolicyRequest?: PluginInstallPolicyRequest;
}): Promise<InstallPluginResult>;
export declare function installPluginFromNpmSpec(params: InstallSafetyOverrides & {
    spec: string;
    extensionsDir?: string;
    npmDir?: string;
    timeoutMs?: number;
    logger?: PluginInstallLogger;
    mode?: "install" | "update";
    dryRun?: boolean;
    expectedPluginId?: string;
    expectedIntegrity?: string;
    onIntegrityDrift?: (params: PluginNpmIntegrityDriftParams) => boolean | Promise<boolean>;
}): Promise<InstallPluginResult>;
export declare function installPluginFromPath(params: {
    path: string;
} & PackageInstallCommonParams): Promise<InstallPluginResult>;
