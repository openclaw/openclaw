import type { PluginDiagnostic } from "./manifest-types.js";
import { type PackageManifest } from "./manifest.js";
import type { PluginOrigin } from "./plugin-origin.types.js";
export declare function validatePackageExtensionEntriesForInstall(params: {
    packageDir: string;
    extensions: string[];
    manifest: PackageManifest;
}): Promise<{
    ok: true;
} | {
    ok: false;
    error: string;
}>;
export declare function resolvePackageSetupSource(params: {
    packageDir: string;
    packageRootRealPath?: string;
    manifest: PackageManifest | null;
    origin: PluginOrigin;
    sourceLabel: string;
    diagnostics: PluginDiagnostic[];
    rejectHardlinks?: boolean;
}): string | null;
export declare function resolvePackageRuntimeExtensionSources(params: {
    packageDir: string;
    packageRootRealPath?: string;
    manifest: PackageManifest | null;
    extensions: readonly string[];
    origin: PluginOrigin;
    pluginIdHint?: string;
    sourceLabel: string;
    diagnostics: PluginDiagnostic[];
    rejectHardlinks?: boolean;
}): string[];
