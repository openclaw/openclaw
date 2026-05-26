import { h as getSubCliEntries } from "./argv-BHL8kwwH.js";
import { t as resolveCliArgvInvocation } from "./argv-invocation-Bmipv42U.js";
import { i as shouldRegisterPrimarySubcommandOnly, n as shouldEagerRegisterSubcommands } from "./command-registration-policy-BjvNLrSK.js";
import { i as registerCommandGroups, r as registerCommandGroupByName } from "./register-command-groups-DYBCwonA.js";
import { i as buildCommandGroupEntries, n as registerSubCliByName$1, o as defineImportedProgramCommandGroupSpecs, r as registerSubCliCommands$1 } from "./register.subclis-core-BP44oPO6.js";
//#region src/cli/program/register.subclis.ts
const entrySpecs = [...defineImportedProgramCommandGroupSpecs([{
	commandNames: ["completion"],
	loadModule: () => import("./completion-cli-BuBY6ozR.js"),
	exportName: "registerCompletionCli"
}])];
function resolveSubCliCommandGroups(argv, context = {}) {
	return buildCommandGroupEntries(getSubCliEntries(), entrySpecs, (register) => async (program) => {
		await register(program, argv, context);
	});
}
async function registerSubCliByName(program, name, argv = process.argv, context = {}) {
	if (await registerSubCliByName$1(program, name, argv, context)) return true;
	return registerCommandGroupByName(program, resolveSubCliCommandGroups(argv, context), name);
}
function registerSubCliCommands(program, argv = process.argv) {
	registerSubCliCommands$1(program, argv);
	const { primary } = resolveCliArgvInvocation(argv);
	registerCommandGroups(program, resolveSubCliCommandGroups(argv), {
		eager: shouldEagerRegisterSubcommands(),
		primary,
		registerPrimaryOnly: Boolean(primary && shouldRegisterPrimarySubcommandOnly(argv))
	});
}
//#endregion
export { registerSubCliCommands as n, registerSubCliByName as t };
