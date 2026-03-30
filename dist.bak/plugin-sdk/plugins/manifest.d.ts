import { MANIFEST_KEY } from "../compat/legacy-names.js";
import type { PluginConfigUiHint, PluginKind } from "./types.js";
export declare const PLUGIN_MANIFEST_FILENAME = "openclaw.plugin.json";
export declare const PLUGIN_MANIFEST_FILENAMES: readonly ["openclaw.plugin.json"];
export type PluginManifest = {
    id: string;
    configSchema: Record<string, unknown>;
    kind?: PluginKind;
    channels?: string[];
    providers?: string[];
    skills?: string[];
    name?: string;
    description?: string;
    version?: string;
    uiHints?: Record<string, PluginConfigUiHint>;
};
export type PluginManifestLoadResult = {
    ok: true;
    manifest: PluginManifest;
    manifestPath: string;
} | {
    ok: false;
    error: string;
    manifestPath: string;
};
export declare function resolvePluginManifestPath(rootDir: string): string;
export declare function loadPluginManifest(rootDir: string): PluginManifestLoadResult;
export type PluginPackageChannel = {
    id?: string;
    label?: string;
    selectionLabel?: string;
    detailLabel?: string;
    docsPath?: string;
    docsLabel?: string;
    blurb?: string;
    order?: number;
    aliases?: string[];
    preferOver?: string[];
    systemImage?: string;
    selectionDocsPrefix?: string;
    selectionDocsOmitLabel?: boolean;
    selectionExtras?: string[];
    showConfigured?: boolean;
    quickstartAllowFrom?: boolean;
    forceAccountBinding?: boolean;
    preferSessionLookupForAnnounceTarget?: boolean;
};
export type PluginPackageInstall = {
    npmSpec?: string;
    localPath?: string;
    defaultChoice?: "npm" | "local";
};
export type OpenClawPackageManifest = {
    extensions?: string[];
    channel?: PluginPackageChannel;
    install?: PluginPackageInstall;
};
export type ManifestKey = typeof MANIFEST_KEY;
export type PackageManifest = {
    name?: string;
    version?: string;
    description?: string;
} & Partial<Record<ManifestKey, OpenClawPackageManifest>>;
export declare function getPackageManifestMetadata(manifest: PackageManifest | undefined): OpenClawPackageManifest | undefined;
