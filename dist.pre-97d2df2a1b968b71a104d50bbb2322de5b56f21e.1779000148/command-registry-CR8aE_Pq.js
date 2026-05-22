import { r as registerCoreCliCommands } from "./command-registry-core-BbFqiGBK.js";
import { n as registerSubCliCommands } from "./register.subclis-BZ3Tt2RY.js";
//#region src/cli/program/command-registry.ts
function registerProgramCommands(program, ctx, argv = process.argv) {
	registerCoreCliCommands(program, ctx, argv);
	registerSubCliCommands(program, argv);
}
//#endregion
export { registerProgramCommands as t };
