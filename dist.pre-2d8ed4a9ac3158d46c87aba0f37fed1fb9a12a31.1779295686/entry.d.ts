import { i as OpenClawConfig } from "./types.openclaw-DPnlcagS.js";
import { n as PluginLoadOptions } from "./loader-S9lpQ5Wv.js";

//#region src/cli/program/root-help.d.ts
type RootHelpRenderOptions = Pick<PluginLoadOptions, "pluginSdkResolution"> & {
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  includePluginDescriptors?: boolean;
};
//#endregion
//#region src/entry.d.ts
declare function tryHandleRootHelpFastPath(argv: string[], deps?: {
  outputPrecomputedRootHelpText?: () => boolean;
  outputRootHelp?: (options?: RootHelpRenderOptions) => void | Promise<void>;
  loadRootHelpRenderOptionsForConfigSensitivePlugins?: (env?: NodeJS.ProcessEnv) => Promise<RootHelpRenderOptions | null>;
  onError?: (error: unknown) => void;
  env?: NodeJS.ProcessEnv;
}): Promise<boolean>;
//#endregion
export { tryHandleRootHelpFastPath };