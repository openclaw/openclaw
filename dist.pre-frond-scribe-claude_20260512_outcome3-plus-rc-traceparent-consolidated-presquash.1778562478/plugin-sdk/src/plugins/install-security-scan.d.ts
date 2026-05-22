type InstallScanLogger = {
    warn?: (message: string) => void;
};
export type { InstallSafetyOverrides } from "./install-security-scan.types.js";
import type { InstallSafetyOverrides } from "./install-security-scan.types.js";
export type InstallSecurityScanResult = {
    blocked?: {
        code?: "security_scan_blocked" | "security_scan_failed";
        reason: string;
    };
};
export type PluginInstallRequestKind = "plugin-dir" | "plugin-archive" | "plugin-file" | "plugin-npm" | "plugin-git";
export type SkillInstallSpecMetadata = {
    id?: string;
    kind: "brew" | "node" | "go" | "uv" | "download";
    label?: string;
    bins?: string[];
    os?: string[];
    formula?: string;
    package?: string;
    module?: string;
    url?: string;
    archive?: string;
    extract?: boolean;
    stripComponents?: number;
    targetDir?: string;
};
export declare function scanBundleInstallSource(params: InstallSafetyOverrides & {
    logger: InstallScanLogger;
    pluginId: string;
    sourceDir: string;
    requestKind?: PluginInstallRequestKind;
    requestedSpecifier?: string;
    mode?: "install" | "update";
    version?: string;
}): Promise<InstallSecurityScanResult | undefined>;
export declare function scanPackageInstallSource(params: InstallSafetyOverrides & {
    extensions: string[];
    logger: InstallScanLogger;
    packageDir: string;
    pluginId: string;
    requestKind?: PluginInstallRequestKind;
    requestedSpecifier?: string;
    mode?: "install" | "update";
    packageName?: string;
    manifestId?: string;
    version?: string;
}): Promise<InstallSecurityScanResult | undefined>;
export declare function scanInstalledPackageDependencyTree(params: {
    allowManagedNpmRootPackagePeerSymlinks?: boolean;
    logger: InstallScanLogger;
    packageDir: string;
    pluginId: string;
}): Promise<InstallSecurityScanResult | undefined>;
export declare function scanFileInstallSource(params: InstallSafetyOverrides & {
    filePath: string;
    logger: InstallScanLogger;
    mode?: "install" | "update";
    pluginId: string;
    requestedSpecifier?: string;
}): Promise<InstallSecurityScanResult | undefined>;
export declare function scanSkillInstallSource(params: {
    dangerouslyForceUnsafeInstall?: boolean;
    installId: string;
    installSpec?: SkillInstallSpecMetadata;
    logger: InstallScanLogger;
    origin: string;
    skillName: string;
    sourceDir: string;
}): Promise<InstallSecurityScanResult | undefined>;
