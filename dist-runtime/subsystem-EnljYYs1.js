import { t as resolveNodeRequireFromMeta } from "./node-require-DvwmVoHm.js";
import { S as normalizeLogLevel, d as getChildLogger, f as getLogger, g as formatLocalIsoWithOffset, m as isFileLogLevelEnabled, r as isVerbose, v as resolveEnvLogLevelOverride, w as readLoggingConfig, x as levelToMinLevel, y as loggingState } from "./globals-I5DlBD2D.js";
import { r as stripAnsi } from "./ansi-YpD2Ho3J.js";
import { Chalk } from "chalk";
import util from "node:util";
//#region src/terminal/progress-line.ts
let activeStream = null;
function registerActiveProgressLine(stream) {
	if (!stream.isTTY) {return;}
	activeStream = stream;
}
function clearActiveProgressLine() {
	if (!activeStream?.isTTY) {return;}
	activeStream.write("\r\x1B[2K");
}
function unregisterActiveProgressLine(stream) {
	if (!activeStream) {return;}
	if (stream && activeStream !== stream) {return;}
	activeStream = null;
}
//#endregion
//#region src/terminal/restore.ts
const RESET_SEQUENCE = "\x1B[0m\x1B[?25h\x1B[?1000l\x1B[?1002l\x1B[?1003l\x1B[?1006l\x1B[?2004l";
function reportRestoreFailure(scope, err, reason) {
	const suffix = reason ? ` (${reason})` : "";
	const message = `[terminal] restore ${scope} failed${suffix}: ${String(err)}`;
	try {
		process.stderr.write(`${message}\n`);
	} catch (writeErr) {
		console.error(`[terminal] restore reporting failed${suffix}: ${String(writeErr)}`);
	}
}
function restoreTerminalState(reason, options = {}) {
	const resumeStdin = options.resumeStdinIfPaused ?? options.resumeStdin ?? false;
	try {
		clearActiveProgressLine();
	} catch (err) {
		reportRestoreFailure("progress line", err, reason);
	}
	const stdin = process.stdin;
	if (stdin.isTTY && typeof stdin.setRawMode === "function") {
		try {
			stdin.setRawMode(false);
		} catch (err) {
			reportRestoreFailure("raw mode", err, reason);
		}
		if (resumeStdin && typeof stdin.isPaused === "function" && stdin.isPaused()) {try {
			stdin.resume();
		} catch (err) {
			reportRestoreFailure("stdin resume", err, reason);
		}}
	}
	if (process.stdout.isTTY) {try {
		process.stdout.write(RESET_SEQUENCE);
	} catch (err) {
		reportRestoreFailure("stdout reset", err, reason);
	}}
}
//#endregion
//#region src/runtime.ts
function shouldEmitRuntimeLog(env = process.env) {
	if (env.VITEST !== "true") {return true;}
	if (env.OPENCLAW_TEST_RUNTIME_LOG === "1") {return true;}
	return typeof console.log.mock === "object";
}
function createRuntimeIo() {
	return {
		log: (...args) => {
			if (!shouldEmitRuntimeLog()) {return;}
			clearActiveProgressLine();
			console.log(...args);
		},
		error: (...args) => {
			clearActiveProgressLine();
			console.error(...args);
		}
	};
}
const defaultRuntime = {
	...createRuntimeIo(),
	exit: (code) => {
		restoreTerminalState("runtime exit", { resumeStdinIfPaused: false });
		process.exit(code);
		throw new Error("unreachable");
	}
};
function createNonExitingRuntime() {
	return {
		...createRuntimeIo(),
		exit: (code) => {
			throw new Error(`exit ${code}`);
		}
	};
}
//#endregion
//#region src/logging/console.ts
const requireConfig = resolveNodeRequireFromMeta(import.meta.url);
const loadConfigFallbackDefault = () => {
	try {
		return (requireConfig?.("../config/config.js"))?.loadConfig?.().logging;
	} catch {
		return;
	}
};
let loadConfigFallback = loadConfigFallbackDefault;
function normalizeConsoleLevel(level) {
	if (isVerbose()) {return "debug";}
	if (!level && process.env.VITEST === "true" && process.env.OPENCLAW_TEST_CONSOLE !== "1") {return "silent";}
	return normalizeLogLevel(level, "info");
}
function normalizeConsoleStyle(style) {
	if (style === "compact" || style === "json" || style === "pretty") {return style;}
	if (!process.stdout.isTTY) {return "compact";}
	return "pretty";
}
function resolveConsoleSettings() {
	const envLevel = resolveEnvLogLevelOverride();
	if (process.env.VITEST === "true" && process.env.OPENCLAW_TEST_CONSOLE !== "1" && !isVerbose() && !envLevel && !loggingState.overrideSettings) {return {
		level: "silent",
		style: normalizeConsoleStyle(void 0)
	};}
	let cfg = loggingState.overrideSettings ?? readLoggingConfig();
	if (!cfg) {if (loggingState.resolvingConsoleSettings) cfg = void 0;
	else {
		loggingState.resolvingConsoleSettings = true;
		try {
			cfg = loadConfigFallback();
		} finally {
			loggingState.resolvingConsoleSettings = false;
		}
	}}
	return {
		level: envLevel ?? normalizeConsoleLevel(cfg?.consoleLevel),
		style: normalizeConsoleStyle(cfg?.consoleStyle)
	};
}
function consoleSettingsChanged(a, b) {
	if (!a) {return true;}
	return a.level !== b.level || a.style !== b.style;
}
function getConsoleSettings() {
	const settings = resolveConsoleSettings();
	const cached = loggingState.cachedConsoleSettings;
	if (!cached || consoleSettingsChanged(cached, settings)) {loggingState.cachedConsoleSettings = settings;}
	return loggingState.cachedConsoleSettings;
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
function shouldLogSubsystemToConsole(subsystem) {
	const filter = loggingState.consoleSubsystemFilter;
	if (!filter || filter.length === 0) {return true;}
	return filter.some((prefix) => subsystem === prefix || subsystem.startsWith(`${prefix}/`));
}
const SUPPRESSED_CONSOLE_PREFIXES = [
	"Closing session:",
	"Opening session:",
	"Removing old closed session:",
	"Session already closed",
	"Session already open"
];
const SUPPRESSED_DISCORD_EVENTQUEUE_LISTENERS = [
	"DiscordMessageListener",
	"DiscordReactionListener",
	"DiscordReactionRemoveListener"
];
function shouldSuppressConsoleMessage(message) {
	if (isVerbose()) {return false;}
	if (SUPPRESSED_CONSOLE_PREFIXES.some((prefix) => message.startsWith(prefix))) {return true;}
	if (message.startsWith("[EventQueue] Slow listener detected") && SUPPRESSED_DISCORD_EVENTQUEUE_LISTENERS.some((listener) => message.includes(listener))) {return true;}
	return false;
}
function isEpipeError(err) {
	const code = err?.code;
	return code === "EPIPE" || code === "EIO";
}
function formatConsoleTimestamp(style) {
	const now = /* @__PURE__ */ new Date();
	if (style === "pretty") {return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;}
	return formatLocalIsoWithOffset(now);
}
function hasTimestampPrefix(value) {
	return /^(?:\d{2}:\d{2}:\d{2}|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)/.test(value);
}
function isJsonPayload(value) {
	const trimmed = value.trim();
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {return false;}
	try {
		JSON.parse(trimmed);
		return true;
	} catch {
		return false;
	}
}
/**
* Route console.* calls through file logging while still emitting to stdout/stderr.
* This keeps user-facing output unchanged but guarantees every console call is captured in log files.
*/
function enableConsoleCapture() {
	if (loggingState.consolePatched) {return;}
	loggingState.consolePatched = true;
	if (!loggingState.streamErrorHandlersInstalled) {
		loggingState.streamErrorHandlersInstalled = true;
		for (const stream of [process.stdout, process.stderr]) {stream.on("error", (err) => {
			if (isEpipeError(err)) return;
			throw err;
		});}
	}
	let logger = null;
	const getLoggerLazy = () => {
		if (!logger) {logger = getLogger();}
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
		if (shouldSuppressConsoleMessage(formatted)) {return;}
		const trimmed = stripAnsi(formatted).trimStart();
		const timestamp = loggingState.consoleTimestampPrefix && trimmed.length > 0 && !hasTimestampPrefix(trimmed) && !isJsonPayload(trimmed) ? formatConsoleTimestamp(getConsoleSettings().style) : "";
		try {
			const resolvedLogger = getLoggerLazy();
			if (level === "trace") {resolvedLogger.trace(formatted);}
			else if (level === "debug") {resolvedLogger.debug(formatted);}
			else if (level === "info") {resolvedLogger.info(formatted);}
			else if (level === "warn") {resolvedLogger.warn(formatted);}
			else if (level === "error" || level === "fatal") {resolvedLogger.error(formatted);}
			else {resolvedLogger.info(formatted);}
		} catch {}
		if (loggingState.forceConsoleToStderr) {try {
			const line = timestamp ? `${timestamp} ${formatted}` : formatted;
			process.stderr.write(`${line}\n`);
		} catch (err) {
			if (isEpipeError(err)) return;
			throw err;
		}}
		else {try {
			if (!timestamp) {
				orig.apply(console, args);
				return;
			}
			if (args.length === 0) {
				orig.call(console, timestamp);
				return;
			}
			if (typeof args[0] === "string") {
				orig.call(console, `${timestamp} ${args[0]}`, ...args.slice(1));
				return;
			}
			orig.call(console, timestamp, ...args);
		} catch (err) {
			if (isEpipeError(err)) return;
			throw err;
		}}
	};
	console.log = forward("info", original.log);
	console.info = forward("info", original.info);
	console.warn = forward("warn", original.warn);
	console.error = forward("error", original.error);
	console.debug = forward("debug", original.debug);
	console.trace = forward("trace", original.trace);
}
//#endregion
//#region src/logging/subsystem.ts
function shouldLogToConsole(level, settings) {
	if (settings.level === "silent") {return false;}
	return levelToMinLevel(level) <= levelToMinLevel(settings.level);
}
const inspectValue = (() => {
	const getBuiltinModule = process.getBuiltinModule;
	if (typeof getBuiltinModule !== "function") {return null;}
	try {
		const utilNamespace = getBuiltinModule("util");
		return typeof utilNamespace.inspect === "function" ? utilNamespace.inspect : null;
	} catch {
		return null;
	}
})();
function formatRuntimeArg(arg) {
	if (typeof arg === "string") {return arg;}
	if (inspectValue) {return inspectValue(arg);}
	try {
		return JSON.stringify(arg);
	} catch {
		return String(arg);
	}
}
function isRichConsoleEnv() {
	const term = (process.env.TERM ?? "").toLowerCase();
	if (process.env.COLORTERM || process.env.TERM_PROGRAM) {return true;}
	return term.length > 0 && term !== "dumb";
}
function getColorForConsole() {
	const hasForceColor = typeof process.env.FORCE_COLOR === "string" && process.env.FORCE_COLOR.trim().length > 0 && process.env.FORCE_COLOR.trim() !== "0";
	if (process.env.NO_COLOR && !hasForceColor) {return new Chalk({ level: 0 });}
	return Boolean(process.stdout.isTTY || process.stderr.isTTY) || isRichConsoleEnv() ? new Chalk({ level: 1 }) : new Chalk({ level: 0 });
}
const SUBSYSTEM_COLORS = [
	"cyan",
	"green",
	"yellow",
	"blue",
	"magenta",
	"red"
];
const SUBSYSTEM_COLOR_OVERRIDES = { "gmail-watcher": "blue" };
const SUBSYSTEM_PREFIXES_TO_DROP = new Set([
	"gateway",
	"channels",
	"providers"
]);
const SUBSYSTEM_MAX_SEGMENTS = 2;
const CHANNEL_SUBSYSTEM_PREFIXES = new Set([
	"telegram",
	"whatsapp",
	"discord",
	"irc",
	"googlechat",
	"slack",
	"signal",
	"imessage"
]);
function pickSubsystemColor(color, subsystem) {
	const override = SUBSYSTEM_COLOR_OVERRIDES[subsystem];
	if (override) return color[override];
	let hash = 0;
	for (let i = 0; i < subsystem.length; i += 1) hash = hash * 31 + subsystem.charCodeAt(i) | 0;
	return color[SUBSYSTEM_COLORS[Math.abs(hash) % SUBSYSTEM_COLORS.length]];
}
function formatSubsystemForConsole(subsystem) {
	const parts = subsystem.split("/").filter(Boolean);
	const original = parts.join("/") || subsystem;
	while (parts.length > 0 && SUBSYSTEM_PREFIXES_TO_DROP.has(parts[0])) {parts.shift();}
	if (parts.length === 0) {return original;}
	if (CHANNEL_SUBSYSTEM_PREFIXES.has(parts[0])) {return parts[0];}
	if (parts.length > SUBSYSTEM_MAX_SEGMENTS) {return parts.slice(-SUBSYSTEM_MAX_SEGMENTS).join("/");}
	return parts.join("/");
}
function stripRedundantSubsystemPrefixForConsole(message, displaySubsystem) {
	if (!displaySubsystem) {return message;}
	if (message.startsWith("[")) {
		const closeIdx = message.indexOf("]");
		if (closeIdx > 1) {
			if (message.slice(1, closeIdx).toLowerCase() === displaySubsystem.toLowerCase()) {
				let i = closeIdx + 1;
				while (message[i] === " ") {i += 1;}
				return message.slice(i);
			}
		}
	}
	if (message.slice(0, displaySubsystem.length).toLowerCase() !== displaySubsystem.toLowerCase()) {return message;}
	const next = message.slice(displaySubsystem.length, displaySubsystem.length + 1);
	if (next !== ":" && next !== " ") {return message;}
	let i = displaySubsystem.length;
	while (message[i] === " ") {i += 1;}
	if (message[i] === ":") {i += 1;}
	while (message[i] === " ") {i += 1;}
	return message.slice(i);
}
function formatConsoleLine(opts) {
	const displaySubsystem = opts.style === "json" ? opts.subsystem : formatSubsystemForConsole(opts.subsystem);
	if (opts.style === "json") {return JSON.stringify({
		time: formatConsoleTimestamp("json"),
		level: opts.level,
		subsystem: displaySubsystem,
		message: opts.message,
		...opts.meta
	});}
	const color = getColorForConsole();
	const prefix = `[${displaySubsystem}]`;
	const prefixColor = pickSubsystemColor(color, displaySubsystem);
	const levelColor = opts.level === "error" || opts.level === "fatal" ? color.red : opts.level === "warn" ? color.yellow : opts.level === "debug" || opts.level === "trace" ? color.gray : color.cyan;
	const displayMessage = stripRedundantSubsystemPrefixForConsole(opts.message, displaySubsystem);
	return `${[(() => {
		if (opts.style === "pretty") {return color.gray(formatConsoleTimestamp("pretty"));}
		if (loggingState.consoleTimestampPrefix) {return color.gray(formatConsoleTimestamp(opts.style));}
		return "";
	})(), prefixColor(prefix)].filter(Boolean).join(" ")} ${levelColor(displayMessage)}`;
}
function writeConsoleLine(level, line) {
	clearActiveProgressLine();
	const sanitized = process.platform === "win32" && process.env.GITHUB_ACTIONS === "true" ? line.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "?").replace(/[\uD800-\uDFFF]/g, "?") : line;
	const sink = loggingState.rawConsole ?? console;
	if (loggingState.forceConsoleToStderr || level === "error" || level === "fatal") {(sink.error ?? console.error)(sanitized);}
	else if (level === "warn") {(sink.warn ?? console.warn)(sanitized);}
	else {(sink.log ?? console.log)(sanitized);}
}
function shouldSuppressProbeConsoleLine(params) {
	if (isVerbose()) {return false;}
	if (params.level === "error" || params.level === "fatal") {return false;}
	if (!(params.subsystem === "agent/embedded" || params.subsystem.startsWith("agent/embedded/") || params.subsystem === "model-fallback" || params.subsystem.startsWith("model-fallback/"))) {return false;}
	if ((typeof params.meta?.runId === "string" ? params.meta.runId : typeof params.meta?.sessionId === "string" ? params.meta.sessionId : void 0)?.startsWith("probe-")) {return true;}
	return /(sessionId|runId)=probe-/.test(params.message);
}
function logToFile(fileLogger, level, message, meta) {
	if (level === "silent") {return;}
	const method = fileLogger[level];
	if (typeof method !== "function") {return;}
	if (meta && Object.keys(meta).length > 0) {method.call(fileLogger, meta, message);}
	else {method.call(fileLogger, message);}
}
function createSubsystemLogger(subsystem) {
	let fileLogger = null;
	const getFileLogger = () => {
		if (!fileLogger) {fileLogger = getChildLogger({ subsystem });}
		return fileLogger;
	};
	const emit = (level, message, meta) => {
		const consoleSettings = getConsoleSettings();
		const consoleEnabled = shouldLogToConsole(level, { level: consoleSettings.level }) && shouldLogSubsystemToConsole(subsystem);
		const fileEnabled = isFileLogLevelEnabled(level);
		if (!consoleEnabled && !fileEnabled) {return;}
		let consoleMessageOverride;
		let fileMeta = meta;
		if (meta && Object.keys(meta).length > 0) {
			const { consoleMessage, ...rest } = meta;
			if (typeof consoleMessage === "string") {consoleMessageOverride = consoleMessage;}
			fileMeta = Object.keys(rest).length > 0 ? rest : void 0;
		}
		if (fileEnabled) {logToFile(getFileLogger(), level, message, fileMeta);}
		if (!consoleEnabled) {return;}
		const consoleMessage = consoleMessageOverride ?? message;
		if (shouldSuppressProbeConsoleLine({
			level,
			subsystem,
			message: consoleMessage,
			meta: fileMeta
		})) {return;}
		writeConsoleLine(level, formatConsoleLine({
			level,
			subsystem,
			message: consoleSettings.style === "json" ? message : consoleMessage,
			style: consoleSettings.style,
			meta: fileMeta
		}));
	};
	const isConsoleEnabled = (level) => {
		return shouldLogToConsole(level, { level: getConsoleSettings().level }) && shouldLogSubsystemToConsole(subsystem);
	};
	const isFileEnabled = (level) => isFileLogLevelEnabled(level);
	return {
		subsystem,
		isEnabled: (level, target = "any") => {
			if (target === "console") {return isConsoleEnabled(level);}
			if (target === "file") {return isFileEnabled(level);}
			return isConsoleEnabled(level) || isFileEnabled(level);
		},
		trace: (message, meta) => emit("trace", message, meta),
		debug: (message, meta) => emit("debug", message, meta),
		info: (message, meta) => emit("info", message, meta),
		warn: (message, meta) => emit("warn", message, meta),
		error: (message, meta) => emit("error", message, meta),
		fatal: (message, meta) => emit("fatal", message, meta),
		raw: (message) => {
			if (isFileEnabled("info")) {logToFile(getFileLogger(), "info", message, { raw: true });}
			if (isConsoleEnabled("info")) {
				if (shouldSuppressProbeConsoleLine({
					level: "info",
					subsystem,
					message
				})) {return;}
				writeConsoleLine("info", message);
			}
		},
		child: (name) => createSubsystemLogger(`${subsystem}/${name}`)
	};
}
function runtimeForLogger(logger, exit = defaultRuntime.exit) {
	const formatArgs = (...args) => args.map((arg) => formatRuntimeArg(arg)).join(" ").trim();
	return {
		log: (...args) => logger.info(formatArgs(...args)),
		error: (...args) => logger.error(formatArgs(...args)),
		exit
	};
}
//#endregion
export { setConsoleSubsystemFilter as a, createNonExitingRuntime as c, clearActiveProgressLine as d, registerActiveProgressLine as f, routeLogsToStderr as i, defaultRuntime as l, runtimeForLogger as n, setConsoleTimestampPrefix as o, unregisterActiveProgressLine as p, enableConsoleCapture as r, shouldLogSubsystemToConsole as s, createSubsystemLogger as t, restoreTerminalState as u };
