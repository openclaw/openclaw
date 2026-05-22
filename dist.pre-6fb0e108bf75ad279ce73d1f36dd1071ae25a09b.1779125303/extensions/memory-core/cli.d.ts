import { Command } from "commander";

//#region extensions/memory-core/src/cli.d.ts
declare function registerMemoryCli(program: Command): void;
//#endregion
export { registerMemoryCli };