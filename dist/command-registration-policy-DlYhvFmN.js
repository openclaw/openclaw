import { t as isTruthyEnvValue } from "./env-Dhqok4CP.js";
import { t as resolveCliArgvInvocation } from "./argv-invocation-C7Tq1otP.js";
//#region src/cli/command-registration-policy.ts
const RESERVED_NON_PLUGIN_COMMAND_ROOTS = new Set([
	"auth",
	"tool",
	"tools"
]);
function isReservedNonPluginCommandRoot(primary) {
	return typeof primary === "string" && RESERVED_NON_PLUGIN_COMMAND_ROOTS.has(primary);
}
function shouldRegisterPrimaryCommandOnly(argv) {
	const invocation = resolveCliArgvInvocation(argv);
	return invocation.primary !== null || !invocation.hasHelpOrVersion;
}
function shouldSkipPluginCommandRegistration(params) {
	const invocation = resolveCliArgvInvocation(params.argv);
	if (params.primary === "help") return invocation.hasHelpOrVersion && invocation.commandPath.length <= 1;
	if (invocation.hasHelpOrVersion) return !params.primary || params.hasBuiltinPrimary || isReservedNonPluginCommandRoot(params.primary);
	if (params.hasBuiltinPrimary) return true;
	if (!params.primary) return invocation.hasHelpOrVersion;
	if (isReservedNonPluginCommandRoot(params.primary)) return true;
	return false;
}
function shouldEagerRegisterSubcommands(env = process.env) {
	return isTruthyEnvValue(env.OPENCLAW_DISABLE_LAZY_SUBCOMMANDS);
}
function shouldRegisterPrimarySubcommandOnly(argv, env = process.env) {
	return !shouldEagerRegisterSubcommands(env) && shouldRegisterPrimaryCommandOnly(argv);
}
//#endregion
export { shouldSkipPluginCommandRegistration as a, shouldRegisterPrimarySubcommandOnly as i, shouldEagerRegisterSubcommands as n, shouldRegisterPrimaryCommandOnly as r, isReservedNonPluginCommandRoot as t };
