import { a as SandboxSshConfig, i as SandboxPruneConfig, t as SandboxBrowserConfig } from "./types-DqQRdgDv.js";

//#region src/plugin-sdk/test-helpers/sandbox-fixtures.d.ts
declare function createSandboxBrowserConfig(overrides?: Partial<SandboxBrowserConfig>): SandboxBrowserConfig;
declare function createSandboxPruneConfig(overrides?: Partial<SandboxPruneConfig>): SandboxPruneConfig;
declare function createSandboxSshConfig(workspaceRoot: string, overrides?: Partial<SandboxSshConfig>): SandboxSshConfig;
//#endregion
//#region src/plugin-sdk/test-helpers/bundled-plugin-paths.d.ts
declare const BUNDLED_PLUGIN_ROOT_DIR = "extensions";
declare const BUNDLED_PLUGIN_PATH_PREFIX = "extensions/";
declare const BUNDLED_PLUGIN_TEST_GLOB = "extensions/**/*.test.ts";
declare function bundledPluginRoot(pluginId: string): string;
declare function bundledPluginFile(pluginId: string, relativePath: string): string;
declare function bundledPluginDirPrefix(pluginId: string, relativeDir: string): string;
declare function bundledPluginRootAt(baseDir: string, pluginId: string): string;
declare function bundledPluginFileAt(baseDir: string, pluginId: string, relativePath: string): string;
declare function bundledDistPluginRoot(pluginId: string): string;
declare function bundledDistPluginFile(pluginId: string, relativePath: string): string;
declare function bundledDistPluginRootAt(baseDir: string, pluginId: string): string;
declare function bundledDistPluginFileAt(baseDir: string, pluginId: string, relativePath: string): string;
declare function installedPluginRoot(baseDir: string, pluginId: string): string;
declare function repoInstallSpec(pluginId: string): string;
//#endregion
//#region src/plugin-sdk/test-helpers/import-fresh.d.ts
declare function importFreshModule<TModule>(from: string, specifier: string): Promise<TModule>;
//#endregion
export { createSandboxPruneConfig as _, bundledDistPluginFile as a, bundledDistPluginRootAt as c, bundledPluginFileAt as d, bundledPluginRoot as f, createSandboxBrowserConfig as g, repoInstallSpec as h, BUNDLED_PLUGIN_TEST_GLOB as i, bundledPluginDirPrefix as l, installedPluginRoot as m, BUNDLED_PLUGIN_PATH_PREFIX as n, bundledDistPluginFileAt as o, bundledPluginRootAt as p, BUNDLED_PLUGIN_ROOT_DIR as r, bundledDistPluginRoot as s, importFreshModule as t, bundledPluginFile as u, createSandboxSshConfig as v };