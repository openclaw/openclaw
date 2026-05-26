import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";

//#region src/plugins/command-specs.d.ts
declare function getPluginCommandSpecs(provider?: string, options?: {
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  workspaceDir?: string;
  config?: OpenClawConfig;
}): Array<{
  name: string;
  description: string;
  descriptionLocalizations?: Record<string, string>;
  acceptsArgs: boolean;
}>;
/** Resolve plugin command specs for a provider's native naming surface without support gating. */
declare function listProviderPluginCommandSpecs(provider?: string): Array<{
  name: string;
  description: string;
  descriptionLocalizations?: Record<string, string>;
  acceptsArgs: boolean;
}>;
//#endregion
export { listProviderPluginCommandSpecs as n, getPluginCommandSpecs as t };