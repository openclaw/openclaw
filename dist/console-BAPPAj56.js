import { f as readLoggingConfig, p as shouldSkipMutatingLoggingConfigRead, s as redactSensitiveText } from "./redact-ok5Q8nmw.js";
import { r as stripAnsi } from "./ansi-4r6vVvJt.js";
import { t as isVerbose } from "./global-state-BAD7XgmL.js";
import { f as formatLocalIsoWithOffset, h as resolveEnvLogLevelOverride, i as getLogger, p as formatTimestamp, v as normalizeLogLevel } from "./logger-Dg9dVaLI.js";
import { t as loggingState } from "./state-CHRYWIGY.js";
import util from "node:util";
//#region src/logging/console.ts
const loadConfigFallbackDefault = () => void 0;
let loadConfigFallback = loadConfigFallbackDefault;
function setConsoleConfigLoaderForTests(loader) {
	loadConfigFallback = loader ?? loadConfigFallbackDefault;
}
function normalizeConsoleLevel(level) {
	if (isVerbose()) return "debug";
	if (!level && process.env.VITEST === "true" && process.env.OPENCLAW_TEST_CONSOLE !== "1") return "silent";
	return normalizeLogLevel(level, "info");
}
function normalizeConsoleStyle(style) {
	if (style === "compact" || style === "json" || style === "pretty") return style;
	if (!process.stdout.isTTY) return "compact";
	return "pretty";
}
function resolveConsoleSettings() {
	const envLevel = resolveEnvLogLevelOverride();
	if (process.env.VITEST === "true" && process.env.OPENCLAW_TEST_CONSOLE !== "1" && !isVerbose() && !envLevel && !loggingState.overrideSettings) return {
		level: "silent",
		style: normalizeConsoleStyle(void 0)
	};
	let cfg = loggingState.overrideSettings ?? readLoggingConfig();
	if (!cfg && !shouldSkipMutatingLoggingConfigRead()) if (loggingState.resolvingConsoleSettings) cfg = void 0;
	else {
		loggingState.resolvingConsoleSettings = true;
		try {
			cfg = loadConfigFallback();
		} finally {
			loggingState.resolvingConsoleSettings = false;
		}
	}
	return {
		level: envLevel ?? normalizeConsoleLevel(cfg?.consoleLevel),
		style: normalizeConsoleStyle(cfg?.consoleStyle)
	};
}
function consoleSettingsChanged(a, b) {
	if (!a) return true;
	return a.level !== b.level || a.style !== b.style;
}
function getConsoleSettings() {
	const settings = resolveConsoleSettings();
	const cached = loggingState.cachedConsoleSettings;
	if (!cached || consoleSettingsChanged(cached, settings)) loggingState.cachedConsoleSettings = settings;
	return loggingState.cachedConsoleSettings;
}
function getResolvedConsoleSettings() {
	return getConsoleSettings();
}
function routeLogsToStderr() {
	loggingState.forceConsoleToStderr = true;
}
function setConsoleSubsystemFilter(filters) {
	if (!filters || filters.length === 0) {
		loggingState.consoleSubsystemFilter = null;
		return;
	}
	const normalized = filters.map((value) => value.trim()).filter((value) => value.length > 0);
	loggingState.consoleSubsystemFilter = normalized.length > 0 ? normalized : null;
}
function setConsoleTimestampPrefix(enabled) {
	loggingState.consoleTimestampPrefix = enabled;
}
function normalizeConsoleSubsystem(subsystem) {
	if (typeof subsystem !== "string") return null;
	const normalized = subsystem.trim();
	return normalized.length > 0 ? normalized : null;
}
function shouldLogSubsystemToConsole(subsystem) {
	const filter = loggingState.consoleSubsystemFilter;
	if (!filter || filter.length === 0) return true;
	const normalizedSubsystem = normalizeConsoleSubsystem(subsystem);
	if (!normalizedSubsystem) return false;
	return filter.some((prefix) => normalizedSubsystem === prefix || normalizedSubsystem.startsWith(`${prefix}/`));
}
const SUPPRESSED_CONSOLE_PREFIXES = [
	"Closing session:",
	"Opening session:",
	"Removing old closed session:",
	"Session already closed",
	"Session already open"
];
function shouldSuppressConsoleMessage(message) {
	if (SUPPRESSED_CONSOLE_PREFIXES.some((prefix) => message.startsWith(prefix))) return true;
	if (isVerbose()) return false;
	return false;
}
function isEpipeError(err) {
	const code = err?.code;
	return code === "EPIPE" || code === "EIO";
}
function formatConsoleTimestamp(style) {
	const now = /* @__PURE__ */ new Date();
	if (style === "pretty") return formatTimestamp(now, { style: "short" }).replace(/[+-]\d{2}:\d{2}$/, "");
	return formatLocalIsoWithOffset(now);
}
function hasTimestampPrefix(value) {
	return /^(?:\d{2}:\d{2}:\d{2}|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)/.test(value);
}
/**
* Route console.* calls through file logging while still emitting to stdout/stderr.
* This keeps user-facing output unchanged but guarantees every console call is captured in log files.
*/
function enableConsoleCapture() {
	if (loggingState.consolePatched) return;
	loggingState.consolePatched = true;
	if (!loggingState.streamErrorHandlersInstalled) {
		loggingState.streamErrorHandlersInstalled = true;
		for (const stream of [process.stdout, process.stderr]) stream.on("error", (err) => {
			if (isEpipeError(err)) return;
			throw err;
		});
	}
	let logger = null;
	const getLoggerLazy = () => {
		if (!logger) logger = getLogger();
		return logger;
	};
	const original = {
		log: console.log,
		info: console.info,
		warn: console.warn,
		error: console.error,
		debug: console.debug,
		trace: console.trace
	};
	loggingState.rawConsole = {
		log: original.log,
		info: original.info,
		warn: original.warn,
		error: original.error
	};
	const forward = (level, orig) => (...args) => {
		const formatted = util.format(...args);
		if (shouldSuppressConsoleMessage(formatted)) return;
		const trimmed = stripAnsi(formatted).trimStart();
		const timestamp = loggingState.consoleTimestampPrefix && trimmed.length > 0 && !hasTimestampPrefix(trimmed) ? formatConsoleTimestamp(getConsoleSettings().style) : "";
		try {
			const resolvedLogger = getLoggerLazy();
			if (level === "trace") resolvedLogger.trace(formatted);
			else if (level === "debug") resolvedLogger.debug(formatted);
			else if (level === "info") resolvedLogger.info(formatted);
			else if (level === "warn") resolvedLogger.warn(formatted);
			else if (level === "error" || level === "fatal") resolvedLogger.error(formatted);
			else resolvedLogger.info(formatted);
		} catch {}
		if (loggingState.forceConsoleToStderr) try {
			const redacted = redactSensitiveText(formatted);
			const line = timestamp ? `${timestamp} ${redacted}` : redacted;
			process.stderr.write(`${line}\n`);
		} catch (err) {
			if (isEpipeError(err)) return;
			throw err;
		}
		else try {
			const redacted = redactSensitiveText(formatted);
			if (!timestamp) {
				if (args.length === 0) {
					orig.apply(console, args);
					return;
				}
				orig.call(console, redacted);
				return;
			}
			orig.call(console, redacted ? `${timestamp} ${redacted}` : timestamp);
		} catch (err) {
			if (isEpipeError(err)) return;
			throw err;
		}
	};
	console.log = forward("info", original.log);
	console.info = forward("info", original.info);
	console.warn = forward("warn", original.warn);
	console.error = forward("error", original.error);
	console.debug = forward("debug", original.debug);
	console.trace = forward("trace", original.trace);
}
//#endregion
export { routeLogsToStderr as a, setConsoleTimestampPrefix as c, getResolvedConsoleSettings as i, shouldLogSubsystemToConsole as l, formatConsoleTimestamp as n, setConsoleConfigLoaderForTests as o, getConsoleSettings as r, setConsoleSubsystemFilter as s, enableConsoleCapture as t };
