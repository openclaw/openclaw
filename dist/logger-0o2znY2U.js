import { r as theme } from "./theme-D58JpUfy.js";
import { n as defaultRuntime } from "./runtime-yzlkhCoS.js";
import { t as isVerbose } from "./global-state-BAD7XgmL.js";
import { i as getLogger } from "./logger-Dg9dVaLI.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
//#region src/logger.ts
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
const info = theme.info;
const warn = theme.warn;
const success = theme.success;
const danger = theme.error;
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
function logSuccess(message, runtime = defaultRuntime) {
	logWithSubsystem({
		message,
		runtime,
		runtimeMethod: "log",
		runtimeFormatter: success,
		loggerMethod: "info",
		subsystemMethod: "info"
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
	if (isVerbose()) console.log(theme.muted(message));
}
//#endregion
export { logWarn as a, logSuccess as i, logError as n, logInfo as r, logDebug as t };
