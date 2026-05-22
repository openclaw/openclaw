import { d as isRootHelpInvocation, n as getCommandPathWithRootOptions, o as getPrimaryCommand, u as isHelpOrVersionInvocation } from "./argv-DLAsQBp6.js";
//#region src/cli/argv-invocation.ts
function resolveCliArgvInvocation(argv) {
	return {
		argv,
		commandPath: getCommandPathWithRootOptions(argv, 2),
		primary: getPrimaryCommand(argv),
		hasHelpOrVersion: isHelpOrVersionInvocation(argv),
		isRootHelpInvocation: isRootHelpInvocation(argv)
	};
}
//#endregion
export { resolveCliArgvInvocation as t };
