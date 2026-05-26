import { i as OpenClawConfig, p as PluginInstallRecord } from "./types.openclaw-BLF4DJTX.js";

//#region src/infra/plugin-install-path-warnings.d.ts
type PluginInstallPathIssue = {
  kind: "custom-path" | "missing-path";
  pluginId: string;
  path: string;
};
declare function detectPluginInstallPathIssue(params: {
  pluginId: string;
  install: PluginInstallRecord | null | undefined;
}): Promise<PluginInstallPathIssue | null>;
declare function formatPluginInstallPathIssue(params: {
  issue: PluginInstallPathIssue;
  pluginLabel: string;
  defaultInstallCommand: string;
  repoInstallCommand?: string | null;
  formatCommand?: (command: string) => string;
}): string[];
//#endregion
//#region src/plugins/uninstall.d.ts
type UninstallActions = {
  entry: boolean;
  install: boolean;
  allowlist: boolean;
  denylist: boolean;
  loadPath: boolean;
  memorySlot: boolean;
  contextEngineSlot: boolean;
  channelConfig: boolean;
  directory: boolean;
};
/**
 * Remove plugin references from config (pure config mutation).
 * Returns a new config with the plugin removed from entries, installs, allow, load.paths, slots,
 * and owned channel config.
 */
declare function removePluginFromConfig(cfg: OpenClawConfig, pluginId: string, opts?: {
  channelIds?: string[];
}): {
  config: OpenClawConfig;
  actions: Omit<UninstallActions, "directory">;
};
//#endregion
export { detectPluginInstallPathIssue as n, formatPluginInstallPathIssue as r, removePluginFromConfig as t };