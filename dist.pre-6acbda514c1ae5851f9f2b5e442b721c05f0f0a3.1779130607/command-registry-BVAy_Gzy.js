import { r as registerCoreCliCommands } from "./command-registry-core-CU2pj79g.js";
import { n as registerSubCliCommands } from "./register.subclis-Cbjsyajn.js";
//#region src/cli/program/command-registry.ts
function registerProgramCommands(program, ctx, argv = process.argv) {
	registerCoreCliCommands(program, ctx, argv);
	registerSubCliCommands(program, argv);
}
//#endregion
export { registerProgramCommands as t };
