//#region src/plugins/manifest-types.d.ts
type PluginConfigUiHint = {
  label?: string;
  help?: string;
  tags?: string[];
  advanced?: boolean;
  sensitive?: boolean;
  placeholder?: string;
};
type PluginFormat = "openclaw" | "bundle";
type PluginBundleFormat = "codex" | "claude" | "cursor";
type PluginDiagnostic = {
  level: "warn" | "error";
  message: string;
  pluginId?: string;
  source?: string;
};
//#endregion
export { PluginFormat as i, PluginConfigUiHint as n, PluginDiagnostic as r, PluginBundleFormat as t };