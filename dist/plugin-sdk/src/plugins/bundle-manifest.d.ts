import type { PluginBundleFormat } from "./manifest-types.js";
export declare const CODEX_BUNDLE_MANIFEST_RELATIVE_PATH = ".codex-plugin/plugin.json";
export declare const CLAUDE_BUNDLE_MANIFEST_RELATIVE_PATH = ".claude-plugin/plugin.json";
export declare const CURSOR_BUNDLE_MANIFEST_RELATIVE_PATH = ".cursor-plugin/plugin.json";
export type BundlePluginManifest = {
    id: string;
    name?: string;
    description?: string;
    version?: string;
    skills: string[];
    settingsFiles?: string[];
    hooks: string[];
    bundleFormat: PluginBundleFormat;
    capabilities: string[];
};
export type BundleManifestLoadResult = {
    ok: true;
    manifest: BundlePluginManifest;
    manifestPath: string;
} | {
    ok: false;
    error: string;
    manifestPath: string;
};
export declare function normalizeBundlePathList(value: unknown): string[];
export declare function mergeBundlePathLists(...groups: string[][]): string[];
export declare function loadBundleManifest(params: {
    rootDir: string;
    rootRealPath?: string;
    bundleFormat: PluginBundleFormat;
    rejectHardlinks?: boolean;
}): BundleManifestLoadResult;
export declare function detectBundleManifestFormat(rootDir: string): PluginBundleFormat | null;
