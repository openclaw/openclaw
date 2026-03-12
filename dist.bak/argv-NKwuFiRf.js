import { n as isNodeRuntime, t as isBunRuntime } from "./runtime-binary-xByxn2JX.js";

//#region src/cli/argv.ts
const HELP_FLAGS = new Set(["-h", "--help"]);
const VERSION_FLAGS = new Set(["-V", "--version"]);
const ROOT_VERSION_ALIAS_FLAG = "-v";
const ROOT_BOOLEAN_FLAGS = new Set(["--dev", "--no-color"]);
const ROOT_VALUE_FLAGS = new Set(["--profile", "--log-level"]);
const FLAG_TERMINATOR = "--";
function hasHelpOrVersion(argv) {
	return argv.some((arg) => HELP_FLAGS.has(arg) || VERSION_FLAGS.has(arg)) || hasRootVersionAlias(argv);
}
function isValueToken(arg) {
	if (!arg) return false;
	if (arg === FLAG_TERMINATOR) return false;
	if (!arg.startsWith("-")) return true;
	return /^-\d+(?:\.\d+)?$/.test(arg);
}
function hasFlag(argv, name) {
	const args = argv.slice(2);
	for (const arg of args) {
		if (arg === FLAG_TERMINATOR) break;
		if (arg === name) return true;
	}
	return false;
}
function hasRootVersionAlias(argv) {
	const args = argv.slice(2);
	let hasAlias = false;
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (!arg) continue;
		if (arg === FLAG_TERMINATOR) break;
		if (arg === ROOT_VERSION_ALIAS_FLAG) {
			hasAlias = true;
			continue;
		}
		if (ROOT_BOOLEAN_FLAGS.has(arg)) continue;
		if (arg.startsWith("--profile=")) continue;
		if (ROOT_VALUE_FLAGS.has(arg)) {
			const next = args[i + 1];
			if (isValueToken(next)) i += 1;
			continue;
		}
		if (arg.startsWith("-")) continue;
		return false;
	}
	return hasAlias;
}
function getVerboseFlag(argv, options) {
	if (hasFlag(argv, "--verbose")) return true;
	if (options?.includeDebug && hasFlag(argv, "--debug")) return true;
	return false;
}
function getCommandPath(argv, depth = 2) {
	const args = argv.slice(2);
	const path = [];
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (!arg) continue;
		if (arg === "--") break;
		if (arg.startsWith("-")) continue;
		path.push(arg);
		if (path.length >= depth) break;
	}
	return path;
}
function getPrimaryCommand(argv) {
	const [primary] = getCommandPath(argv, 1);
	return primary ?? null;
}
function buildParseArgv(params) {
	const baseArgv = params.rawArgs && params.rawArgs.length > 0 ? params.rawArgs : params.fallbackArgv && params.fallbackArgv.length > 0 ? params.fallbackArgv : process.argv;
	const programName = params.programName ?? "";
	const normalizedArgv = programName && baseArgv[0] === programName ? baseArgv.slice(1) : baseArgv[0]?.endsWith("openclaw") ? baseArgv.slice(1) : baseArgv;
	if (normalizedArgv.length >= 2 && (isNodeRuntime(normalizedArgv[0] ?? "") || isBunRuntime(normalizedArgv[0] ?? ""))) return normalizedArgv;
	return [
		"node",
		programName || "openclaw",
		...normalizedArgv
	];
}
function shouldMigrateStateFromPath(path) {
	if (path.length === 0) return true;
	const [primary, secondary] = path;
	if (primary === "health" || primary === "status" || primary === "sessions") return false;
	if (primary === "config" && (secondary === "get" || secondary === "unset")) return false;
	if (primary === "models" && (secondary === "list" || secondary === "status")) return false;
	if (primary === "memory" && secondary === "status") return false;
	if (primary === "agent") return false;
	return true;
}

//#endregion
export { hasFlag as a, shouldMigrateStateFromPath as c, getVerboseFlag as i, getCommandPath as n, hasHelpOrVersion as o, getPrimaryCommand as r, hasRootVersionAlias as s, buildParseArgv as t };