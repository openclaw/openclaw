import { r as registerCoreCliCommands } from "./command-registry-core-B9_G6UKe.js";
import { n as registerSubCliCommands } from "./register.subclis-V-U6d6yg.js";
//#region src/cli/program/command-registry.ts
function registerProgramCommands(program, ctx, argv = process.argv) {
	registerCoreCliCommands(program, ctx, argv);
	registerSubCliCommands(program, argv);
}
//#endregion
export { registerProgramCommands as t };
