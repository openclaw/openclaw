import { r as registerCoreCliCommands } from "./command-registry-core-C8rdmk5R.js";
import { n as registerSubCliCommands } from "./register.subclis-C6FeOquW.js";
//#region src/cli/program/command-registry.ts
function registerProgramCommands(program, ctx, argv = process.argv) {
	registerCoreCliCommands(program, ctx, argv);
	registerSubCliCommands(program, argv);
}
//#endregion
export { registerProgramCommands as t };
