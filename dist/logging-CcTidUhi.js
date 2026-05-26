import { i as setMatrixConsoleLogging, n as LogService, t as ConsoleLogger } from "./logger-CjN9_ytq.js";
import { logger } from "matrix-js-sdk/lib/logger.js";
//#region extensions/matrix/src/matrix/client/logging.ts
let matrixSdkLoggingConfigured = false;
let matrixSdkLogMode = "default";
const matrixSdkBaseLogger = new ConsoleLogger();
let matrixJsSdkRootLoggerSnapshot = null;
function shouldSuppressMatrixHttpNotFound(module, messageOrObject) {
	if (!module.includes("MatrixHttpClient")) return false;
	return messageOrObject.some((entry) => {
		if (!entry || typeof entry !== "object") return false;
		return entry.errcode === "M_NOT_FOUND";
	});
}
function ensureMatrixSdkLoggingConfigured() {
	if (!matrixSdkLoggingConfigured) matrixSdkLoggingConfigured = true;
	applyMatrixSdkLogger();
}
function setMatrixSdkLogMode(mode) {
	matrixSdkLogMode = mode;
	if (!matrixSdkLoggingConfigured) return;
	applyMatrixSdkLogger();
}
function setMatrixSdkConsoleLogging(enabled) {
	setMatrixConsoleLogging(enabled);
}
function createMatrixJsSdkClientLogger(prefix = "matrix") {
	return createMatrixJsSdkLoggerInstance(prefix);
}
function applyMatrixSdkLogger() {
	if (matrixSdkLogMode === "quiet") {
		setMatrixJsSdkRootLoggerLevel("silent");
		LogService.setLogger({
			trace: () => {},
			debug: () => {},
			info: () => {},
			warn: () => {},
			error: () => {}
		});
		return;
	}
	setMatrixJsSdkRootLoggerLevel("debug");
	LogService.setLogger({
		trace: (module, ...messageOrObject) => matrixSdkBaseLogger.trace(module, ...messageOrObject),
		debug: (module, ...messageOrObject) => matrixSdkBaseLogger.debug(module, ...messageOrObject),
		info: (module, ...messageOrObject) => matrixSdkBaseLogger.info(module, ...messageOrObject),
		warn: (module, ...messageOrObject) => matrixSdkBaseLogger.warn(module, ...messageOrObject),
		error: (module, ...messageOrObject) => {
			if (shouldSuppressMatrixHttpNotFound(module, messageOrObject)) return;
			matrixSdkBaseLogger.error(module, ...messageOrObject);
		}
	});
}
function setMatrixJsSdkRootLoggerLevel(level) {
	const logger$1 = logger;
	matrixJsSdkRootLoggerSnapshot ??= {
		level: logger$1.getLevel?.(),
		methodFactory: logger$1.methodFactory
	};
	if (level === "silent") {
		logger$1.methodFactory = () => () => void 0;
		logger$1.setLevel?.("silent", false);
		logger$1.rebuild?.();
		return;
	}
	logger$1.methodFactory = matrixJsSdkRootLoggerSnapshot.methodFactory;
	const previousLevel = matrixJsSdkRootLoggerSnapshot.level;
	if (typeof previousLevel === "string" || typeof previousLevel === "number") logger$1.setLevel?.(previousLevel, false);
	logger$1.rebuild?.();
}
function createMatrixJsSdkLoggerInstance(prefix) {
	const log = (method, ...messageOrObject) => {
		if (matrixSdkLogMode === "quiet") return;
		matrixSdkBaseLogger[method](prefix, ...messageOrObject);
	};
	return {
		trace: (...messageOrObject) => log("trace", ...messageOrObject),
		debug: (...messageOrObject) => log("debug", ...messageOrObject),
		info: (...messageOrObject) => log("info", ...messageOrObject),
		warn: (...messageOrObject) => log("warn", ...messageOrObject),
		error: (...messageOrObject) => {
			if (shouldSuppressMatrixHttpNotFound(prefix, messageOrObject)) return;
			log("error", ...messageOrObject);
		},
		getChild: (namespace) => {
			const nextNamespace = namespace.trim();
			return createMatrixJsSdkLoggerInstance(nextNamespace ? `${prefix}.${nextNamespace}` : prefix);
		}
	};
}
//#endregion
export { setMatrixSdkLogMode as i, ensureMatrixSdkLoggingConfigured as n, setMatrixSdkConsoleLogging as r, createMatrixJsSdkClientLogger as t };
