import { s as redactSensitiveText } from "./redact-ok5Q8nmw.js";
import "./logging-core-DwEC9Ajh.js";
import { t as getMatrixRuntime } from "./runtime-Bzh7h5rJ.js";
import { format } from "node:util";
//#region extensions/matrix/src/matrix/sdk/logger.ts
function noop() {}
let forceConsoleLogging = false;
function setMatrixConsoleLogging(enabled) {
	forceConsoleLogging = enabled;
}
function resolveRuntimeLogger(module) {
	if (forceConsoleLogging) return null;
	try {
		return getMatrixRuntime().logging.getChildLogger({ module: `matrix:${module}` });
	} catch {
		return null;
	}
}
function formatMessage(module, messageOrObject) {
	if (messageOrObject.length === 0) return `[${module}]`;
	return redactSensitiveText(`[${module}] ${format(...messageOrObject)}`);
}
var ConsoleLogger = class {
	emit(level, module, ...messageOrObject) {
		const runtimeLogger = resolveRuntimeLogger(module);
		const message = formatMessage(module, messageOrObject);
		if (runtimeLogger) {
			if (level === "debug") {
				runtimeLogger.debug?.(message);
				return;
			}
			runtimeLogger[level](message);
			return;
		}
		if (level === "debug") {
			console.debug(message);
			return;
		}
		console[level](message);
	}
	trace(module, ...messageOrObject) {
		this.emit("debug", module, ...messageOrObject);
	}
	debug(module, ...messageOrObject) {
		this.emit("debug", module, ...messageOrObject);
	}
	info(module, ...messageOrObject) {
		this.emit("info", module, ...messageOrObject);
	}
	warn(module, ...messageOrObject) {
		this.emit("warn", module, ...messageOrObject);
	}
	error(module, ...messageOrObject) {
		this.emit("error", module, ...messageOrObject);
	}
};
let activeLogger = new ConsoleLogger();
const LogService = {
	setLogger(logger) {
		activeLogger = logger;
	},
	trace(module, ...messageOrObject) {
		activeLogger.trace(module, ...messageOrObject);
	},
	debug(module, ...messageOrObject) {
		activeLogger.debug(module, ...messageOrObject);
	},
	info(module, ...messageOrObject) {
		activeLogger.info(module, ...messageOrObject);
	},
	warn(module, ...messageOrObject) {
		activeLogger.warn(module, ...messageOrObject);
	},
	error(module, ...messageOrObject) {
		activeLogger.error(module, ...messageOrObject);
	}
};
//#endregion
export { setMatrixConsoleLogging as i, LogService as n, noop as r, ConsoleLogger as t };
