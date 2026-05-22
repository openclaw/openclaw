import type { ClawHubPluginInstallRecordFields } from "./clawhub-install-records.js";
import type { InstallSafetyOverrides } from "./install-security-scan.js";
import { type InstallPluginResult } from "./install.js";
export declare const CLAWHUB_INSTALL_ERROR_CODE: {
    readonly INVALID_SPEC: "invalid_spec";
    readonly PACKAGE_NOT_FOUND: "package_not_found";
    readonly VERSION_NOT_FOUND: "version_not_found";
    readonly NO_INSTALLABLE_VERSION: "no_installable_version";
    readonly SKILL_PACKAGE: "skill_package";
    readonly UNSUPPORTED_FAMILY: "unsupported_family";
    readonly PRIVATE_PACKAGE: "private_package";
    readonly INCOMPATIBLE_PLUGIN_API: "incompatible_plugin_api";
    readonly INCOMPATIBLE_GATEWAY: "incompatible_gateway";
    readonly MISSING_ARCHIVE_INTEGRITY: "missing_archive_integrity";
    readonly ARCHIVE_INTEGRITY_MISMATCH: "archive_integrity_mismatch";
};
export type ClawHubInstallErrorCode = (typeof CLAWHUB_INSTALL_ERROR_CODE)[keyof typeof CLAWHUB_INSTALL_ERROR_CODE];
type PluginInstallLogger = {
    info?: (message: string) => void;
    warn?: (message: string) => void;
};
type ClawHubInstallFailure = {
    ok: false;
    error: string;
    code?: ClawHubInstallErrorCode;
};
export declare function formatClawHubSpecifier(params: {
    name: string;
    version?: string;
}): string;
export declare function installPluginFromClawHub(params: InstallSafetyOverrides & {
    spec: string;
    baseUrl?: string;
    token?: string;
    logger?: PluginInstallLogger;
    mode?: "install" | "update";
    extensionsDir?: string;
    timeoutMs?: number;
    dryRun?: boolean;
    expectedPluginId?: string;
}): Promise<({
    ok: true;
} & Extract<InstallPluginResult, {
    ok: true;
}> & {
    clawhub: ClawHubPluginInstallRecordFields;
    packageName: string;
}) | ClawHubInstallFailure | Extract<InstallPluginResult, {
    ok: false;
}>>;
export {};
