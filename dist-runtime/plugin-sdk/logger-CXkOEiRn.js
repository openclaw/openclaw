import { n as getLogger, r as init_logger } from "./logger-D1gzveLR.js";
import { C as warn, c as defaultRuntime, g as init_globals, h as info, l as init_runtime, m as danger, n as init_subsystem, t as createSubsystemLogger, y as logVerboseConsole } from "./subsystem-0lZt3jI5.js";
//#region src/logger.ts
init_globals();
init_logger();
init_subsystem();
init_runtime();
const subsystemPrefixRe = /^([a-z][a-z0-9-]{1,20}):\s+(.*)$/i;
function splitSubsystem(message) {
	const match = message.match(subsystemPrefixRe);
	if (!match) return null;
	const [, subsystem, rest] = match;
	return {
		subsystem,
		rest
	};
}
function logWithSubsystem(params) {
	const parsed = params.runtime === defaultRuntime ? splitSubsystem(params.message) : null;
	if (parsed) {
		createSubsystemLogger(parsed.subsystem)[params.subsystemMethod](parsed.rest);
		return;
	}
	params.runtime[params.runtimeMethod](params.runtimeFormatter(params.message));
	getLogger()[params.loggerMethod](params.message);
}
function logInfo(message, runtime = defaultRuntime) {
	logWithSubsystem({
		message,
		runtime,
		runtimeMethod: "log",
		runtimeFormatter: info,
		loggerMethod: "info",
		subsystemMethod: "info"
	});
}
function logWarn(message, runtime = defaultRuntime) {
	logWithSubsystem({
		message,
		runtime,
		runtimeMethod: "log",
		runtimeFormatter: warn,
		loggerMethod: "warn",
		subsystemMethod: "warn"
	});
}
function logError(message, runtime = defaultRuntime) {
	logWithSubsystem({
		message,
		runtime,
		runtimeMethod: "error",
		runtimeFormatter: danger,
		loggerMethod: "error",
		subsystemMethod: "error"
	});
}
function logDebug(message) {
	getLogger().debug(message);
	logVerboseConsole(message);
}
//#endregion
export { logWarn as i, logError as n, logInfo as r, logDebug as t };
