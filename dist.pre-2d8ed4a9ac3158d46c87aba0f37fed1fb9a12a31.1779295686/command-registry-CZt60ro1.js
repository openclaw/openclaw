import { r as registerCoreCliCommands } from "./command-registry-core-JG3g5ndK.js";
import { n as registerSubCliCommands } from "./register.subclis-CHLy9_vI.js";
//#region src/cli/program/command-registry.ts
function registerProgramCommands(program, ctx, argv = process.argv) {
	registerCoreCliCommands(program, ctx, argv);
	registerSubCliCommands(program, argv);
}
//#endregion
export { registerProgramCommands as t };
