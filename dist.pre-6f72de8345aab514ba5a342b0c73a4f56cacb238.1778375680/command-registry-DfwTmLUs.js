import { r as registerCoreCliCommands } from "./command-registry-core-DBMpbnHD.js";
import { n as registerSubCliCommands } from "./register.subclis-B12V_eFV.js";
//#region src/cli/program/command-registry.ts
function registerProgramCommands(program, ctx, argv = process.argv) {
	registerCoreCliCommands(program, ctx, argv);
	registerSubCliCommands(program, argv);
}
//#endregion
export { registerProgramCommands as t };
