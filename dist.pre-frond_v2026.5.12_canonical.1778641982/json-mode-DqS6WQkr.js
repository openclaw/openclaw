import { c as hasFlag } from "./argv-DLAsQBp6.js";
//#region src/cli/program/json-mode.ts
const jsonModeSymbol = Symbol("openclaw.cli.jsonMode");
function commandDefinesJsonOption(command) {
	return command.options.some((option) => option.long === "--json");
}
function getDeclaredCommandJsonMode(command) {
	for (let current = command; current; current = current.parent ?? null) {
		const metadata = current[jsonModeSymbol];
		if (metadata) return metadata;
		if (commandDefinesJsonOption(current)) return "output";
	}
	return null;
}
function commandSelectedJsonFlag(command, argv) {
	const commandWithGlobals = command;
	if (typeof commandWithGlobals.optsWithGlobals === "function") {
		if (commandWithGlobals.optsWithGlobals().json === true) return true;
	}
	return hasFlag(argv, "--json");
}
function setCommandJsonMode(command, mode) {
	command[jsonModeSymbol] = mode;
	return command;
}
function getCommandJsonMode(command, argv = process.argv) {
	if (!commandSelectedJsonFlag(command, argv)) return null;
	return getDeclaredCommandJsonMode(command);
}
function isCommandJsonOutputMode(command, argv = process.argv) {
	return getCommandJsonMode(command, argv) === "output";
}
//#endregion
export { setCommandJsonMode as n, isCommandJsonOutputMode as t };
