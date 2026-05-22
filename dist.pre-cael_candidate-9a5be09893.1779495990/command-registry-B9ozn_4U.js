import { r as registerCoreCliCommands } from "./command-registry-core-D1AcKOpY.js";
import { n as registerSubCliCommands } from "./register.subclis-B0sL3urN.js";
//#region src/cli/program/command-registry.ts
function registerProgramCommands(program, ctx, argv = process.argv) {
	registerCoreCliCommands(program, ctx, argv);
	registerSubCliCommands(program, argv);
}
//#endregion
export { registerProgramCommands as t };
