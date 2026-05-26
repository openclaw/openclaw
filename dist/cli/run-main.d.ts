import { i as OpenClawConfig } from "../types.openclaw-DIZy8jcb.js";
import { n as PluginManifestCommandAliasRegistry } from "../manifest-command-aliases-C3Hr2GVL.js";

//#region src/cli/run-main-policy.d.ts
declare function rewriteUpdateFlagArgv(argv: string[]): string[];
declare function shouldEnsureCliPath(argv: string[]): boolean;
declare function shouldUseRootHelpFastPath(argv: string[], env?: NodeJS.ProcessEnv): boolean;
declare function shouldUseBrowserHelpFastPath(argv: string[], env?: NodeJS.ProcessEnv): boolean;
declare function shouldStartCrestodianForBareRoot(argv: string[]): boolean;
declare function shouldStartCrestodianForModernOnboard(argv: string[]): boolean;
declare function shouldStartProxyForCli(argv: string[]): boolean;
//#endregion
//#region src/cli/run-main.d.ts
declare function isGatewayRunFastPathArgv(argv: string[]): boolean;
declare function resolveMissingPluginCommandMessage(pluginId: string, config?: OpenClawConfig, options?: {
  registry?: PluginManifestCommandAliasRegistry;
}): string | null;
declare function runCli(argv?: string[]): Promise<void>;
declare function isCliMainModule(): boolean;
//#endregion
export { isCliMainModule, isGatewayRunFastPathArgv, resolveMissingPluginCommandMessage, rewriteUpdateFlagArgv, runCli, shouldEnsureCliPath, shouldStartCrestodianForBareRoot, shouldStartCrestodianForModernOnboard, shouldStartProxyForCli, shouldUseBrowserHelpFastPath, shouldUseRootHelpFastPath };