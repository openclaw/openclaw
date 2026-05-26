import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { n as PluginLoadOptions } from "./loader-DVJWgNxt.js";

//#region src/cli/program/root-help.d.ts
type RootHelpRenderOptions = Pick<PluginLoadOptions, "pluginSdkResolution"> & {
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  includePluginDescriptors?: boolean;
};
//#endregion
//#region src/entry.d.ts
type OutputPrecomputedHelpText = () => boolean;
declare function tryHandleRootHelpFastPath(argv: string[], deps?: {
  outputPrecomputedRootHelpText?: () => boolean;
  outputRootHelp?: (options?: RootHelpRenderOptions) => void | Promise<void>;
  loadRootHelpRenderOptionsForConfigSensitivePlugins?: (env?: NodeJS.ProcessEnv) => Promise<RootHelpRenderOptions | null>;
  onError?: (error: unknown) => void;
  env?: NodeJS.ProcessEnv;
}): Promise<boolean>;
declare function tryHandlePrecomputedCommandHelpFastPath(argv: string[], deps?: {
  outputPrecomputedBrowserHelpText?: OutputPrecomputedHelpText;
  outputPrecomputedSecretsHelpText?: OutputPrecomputedHelpText;
  outputPrecomputedNodesHelpText?: OutputPrecomputedHelpText;
  loadRootHelpRenderOptionsForConfigSensitivePlugins?: (env?: NodeJS.ProcessEnv) => Promise<RootHelpRenderOptions | null>;
  env?: NodeJS.ProcessEnv;
}): Promise<boolean>;
//#endregion
export { tryHandlePrecomputedCommandHelpFastPath, tryHandleRootHelpFastPath };