import { i as OpenClawConfig } from "../types.openclaw-BLF4DJTX.js";
import { n as PluginManifestCommandAliasRegistry } from "../manifest-command-aliases-BBRdBljz.js";

//#region src/cli/run-main-policy.d.ts
declare function rewriteUpdateFlagArgv(argv: string[]): string[];
declare function shouldEnsureCliPath(argv: string[]): boolean;
declare function shouldUseRootHelpFastPath(argv: string[], env?: NodeJS.ProcessEnv): boolean;
declare function shouldUseBrowserHelpFastPath(argv: string[], env?: NodeJS.ProcessEnv): boolean;
declare function shouldUseSecretsHelpFastPath(argv: string[], env?: NodeJS.ProcessEnv): boolean;
declare function shouldUseNodesHelpFastPath(argv: string[], env?: NodeJS.ProcessEnv): boolean;
declare function shouldUseSetupOnboardConfigureHelpFastPath(argv: string[], env?: NodeJS.ProcessEnv): boolean;
declare function resolvePrecomputedSubcommandHelpFastPath(argv: string[], env?: NodeJS.ProcessEnv): string | null;
declare function shouldStartCrestodianForBareRoot(argv: string[]): boolean;
declare function shouldStartCrestodianForModernOnboard(argv: string[]): boolean;
declare function shouldStartProxyForCli(argv: string[]): boolean;
//#endregion
//#region src/cli/run-main.d.ts
declare function isGatewayRunFastPathArgv(argv: string[]): boolean;
declare function shouldStartOnboardingForFreshInstall(argv: string[]): Promise<boolean>;
declare function resolveMissingPluginCommandMessage(pluginId: string, config?: OpenClawConfig, options?: {
  registry?: PluginManifestCommandAliasRegistry;
}): string | null;
declare function runCli(argv?: string[]): Promise<void>;
declare function isCliMainModule(): boolean;
//#endregion
export { isCliMainModule, isGatewayRunFastPathArgv, resolveMissingPluginCommandMessage, resolvePrecomputedSubcommandHelpFastPath, rewriteUpdateFlagArgv, runCli, shouldEnsureCliPath, shouldStartCrestodianForBareRoot, shouldStartCrestodianForModernOnboard, shouldStartOnboardingForFreshInstall, shouldStartProxyForCli, shouldUseBrowserHelpFastPath, shouldUseNodesHelpFastPath, shouldUseRootHelpFastPath, shouldUseSecretsHelpFastPath, shouldUseSetupOnboardConfigureHelpFastPath };