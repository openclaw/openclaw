import { t as __exportAll } from "./rolldown-runtime-Cbj13DAv.js";

//#region src/cli/program/program-context.ts
var program_context_exports = /* @__PURE__ */ __exportAll({
	getProgramContext: () => getProgramContext,
	setProgramContext: () => setProgramContext
});
const PROGRAM_CONTEXT_SYMBOL = Symbol.for("openclaw.cli.programContext");
function setProgramContext(program, ctx) {
	program[PROGRAM_CONTEXT_SYMBOL] = ctx;
}
function getProgramContext(program) {
	return program[PROGRAM_CONTEXT_SYMBOL];
}

//#endregion
export { program_context_exports as n, setProgramContext as r, getProgramContext as t };