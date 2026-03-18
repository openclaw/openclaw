import { n as __esmMin } from "./chunk-DORXReHP.js";
import { _ as normalizeLogLevel, c as init_timestamps, d as init_env_log_level, f as resolveEnvLogLevelOverride, g as levelToMinLevel, h as init_levels, i as isFileLogLevelEnabled, l as init_node_require, m as loggingState, n as getLogger, p as init_state, r as init_logger, s as formatLocalIsoWithOffset, t as getChildLogger, u as resolveNodeRequireFromMeta, v as init_config, y as readLoggingConfig } from "./logger-D1gzveLR.js";
import chalk, { Chalk } from "chalk";
import "node:util";
//#region src/terminal/palette.ts
var LOBSTER_PALETTE;
var init_palette = __esmMin((() => {
	LOBSTER_PALETTE = {
		accent: "#FF5A2D",
		accentBright: "#FF7A3D",
		accentDim: "#D14A22",
		info: "#FF8A5B",
		success: "#2FBF71",
		warn: "#FFB020",
		error: "#E23D2D",
		muted: "#8B7F77"
	};
}));
//#endregion
//#region src/terminal/theme.ts
var hasForceColor, baseChalk, hex, theme, isRich, colorize;
var init_theme = __esmMin((() => {
	init_palette();
	hasForceColor = typeof process.env.FORCE_COLOR === "string" && process.env.FORCE_COLOR.trim().length > 0 && process.env.FORCE_COLOR.trim() !== "0";
	baseChalk = process.env.NO_COLOR && !hasForceColor ? new Chalk({ level: 0 }) : chalk;
	hex = (value) => baseChalk.hex(value);
	theme = {
		accent: hex(LOBSTER_PALETTE.accent),
		accentBright: hex(LOBSTER_PALETTE.accentBright),
		accentDim: hex(LOBSTER_PALETTE.accentDim),
		info: hex(LOBSTER_PALETTE.info),
		success: hex(LOBSTER_PALETTE.success),
		warn: hex(LOBSTER_PALETTE.warn),
		error: hex(LOBSTER_PALETTE.error),
		muted: hex(LOBSTER_PALETTE.muted),
		heading: baseChalk.bold.hex(LOBSTER_PALETTE.accent),
		command: hex(LOBSTER_PALETTE.accentBright),
		option: hex(LOBSTER_PALETTE.warn)
	};
	isRich = () => Boolean(baseChalk.level > 0);
	colorize = (rich, color, value) => rich ? color(value) : value;
}));
//#endregion
//#region src/globals.ts
function setVerbose(v) {
	globalVerbose = v;
}
function isVerbose() {
	return globalVerbose;
}
function shouldLogVerbose() {
	return globalVerbose || isFileLogLevelEnabled("debug");
}
function logVerbose(message) {
	if (!shouldLogVerbose()) return;
	try {
		getLogger().debug({ message }, "verbose");
	} catch {}
	if (!globalVerbose) return;
	console.log(theme.muted(message));
}
function logVerboseConsole(message) {
	if (!globalVerbose) return;
	console.log(theme.muted(message));
}
var globalVerbose, success, warn, info, danger;
var init_globals = __esmMin((() => {
	init_logger();
	init_theme();
	globalVerbose = false;
	success = theme.success;
	warn = theme.warn;
	info = theme.info;
	danger = theme.error;
}));
//#endregion
//#region src/terminal/progress-line.ts
function registerActiveProgressLine(stream) {
	if (!stream.isTTY) return;
	activeStream = stream;
}
function clearActiveProgressLine() {
	if (!activeStream?.isTTY) return;
	activeStream.write("\r\x1B[2K");
}
function unregisterActiveProgressLine(stream) {
	if (!activeStream) return;
	if (stream && activeStream !== stream) return;
	activeStream = null;
}
var activeStream;
var init_progress_line = __esmMin((() => {
	activeStream = null;
}));
//#endregion
//#region src/terminal/restore.ts
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
		if (resumeStdin && typeof stdin.isPaused === "function" && stdin.isPaused()) try {
			stdin.resume();
		} catch (err) {
			reportRestoreFailure("stdin resume", err, reason);
		}
	}
	if (process.stdout.isTTY) try {
		process.stdout.write(RESET_SEQUENCE);
	} catch (err) {
		reportRestoreFailure("stdout reset", err, reason);
	}
}
var RESET_SEQUENCE;
var init_restore = __esmMin((() => {
	init_progress_line();
	RESET_SEQUENCE = "\x1B[0m\x1B[?25h\x1B[?1000l\x1B[?1002l\x1B[?1003l\x1B[?1006l\x1B[?2004l";
}));
//#endregion
//#region src/runtime.ts
function shouldEmitRuntimeLog(env = process.env) {
	if (env.VITEST !== "true") return true;
	if (env.OPENCLAW_TEST_RUNTIME_LOG === "1") return true;
	return typeof console.log.mock === "object";
}
function createRuntimeIo() {
	return {
		log: (...args) => {
			if (!shouldEmitRuntimeLog()) return;
			clearActiveProgressLine();
			console.log(...args);
		},
		error: (...args) => {
			clearActiveProgressLine();
			console.error(...args);
		}
	};
}
function createNonExitingRuntime() {
	return {
		...createRuntimeIo(),
		exit: (code) => {
			throw new Error(`exit ${code}`);
		}
	};
}
var defaultRuntime;
var init_runtime = __esmMin((() => {
	init_progress_line();
	init_restore();
	defaultRuntime = {
		...createRuntimeIo(),
		exit: (code) => {
			restoreTerminalState("runtime exit", { resumeStdinIfPaused: false });
			process.exit(code);
			throw new Error("unreachable");
		}
	};
}));
//#endregion
//#region src/terminal/ansi.ts
function stripAnsi(input) {
	return input.replace(OSC8_REGEX, "").replace(ANSI_REGEX, "");
}
/**
* Sanitize a value for safe interpolation into log messages.
* Strips ANSI escape sequences, C0 control characters (U+0000–U+001F),
* and DEL (U+007F) to prevent log forging / terminal escape injection (CWE-117).
*/
function sanitizeForLog(v) {
	let out = stripAnsi(v);
	for (let c = 0; c <= 31; c++) out = out.replaceAll(String.fromCharCode(c), "");
	return out.replaceAll(String.fromCharCode(127), "");
}
var ANSI_SGR_PATTERN, OSC8_PATTERN, ANSI_REGEX, OSC8_REGEX;
var init_ansi = __esmMin((() => {
	ANSI_SGR_PATTERN = "\\x1b\\[[0-9;]*m";
	OSC8_PATTERN = "\\x1b\\]8;;.*?\\x1b\\\\|\\x1b\\]8;;\\x1b\\\\";
	ANSI_REGEX = new RegExp(ANSI_SGR_PATTERN, "g");
	OSC8_REGEX = new RegExp(OSC8_PATTERN, "g");
	typeof Intl !== "undefined" && "Segmenter" in Intl && new Intl.Segmenter(void 0, { granularity: "grapheme" });
}));
//#endregion
//#region src/logging/console.ts
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
	if (!cfg) if (loggingState.resolvingConsoleSettings) cfg = void 0;
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
function shouldLogSubsystemToConsole(subsystem) {
	const filter = loggingState.consoleSubsystemFilter;
	if (!filter || filter.length === 0) return true;
	return filter.some((prefix) => subsystem === prefix || subsystem.startsWith(`${prefix}/`));
}
function formatConsoleTimestamp(style) {
	const now = /* @__PURE__ */ new Date();
	if (style === "pretty") return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
	return formatLocalIsoWithOffset(now);
}
var requireConfig, loadConfigFallbackDefault, loadConfigFallback;
var init_console = __esmMin((() => {
	init_globals();
	init_ansi();
	init_config();
	init_env_log_level();
	init_levels();
	init_logger();
	init_node_require();
	init_state();
	init_timestamps();
	requireConfig = resolveNodeRequireFromMeta(import.meta.url);
	loadConfigFallbackDefault = () => {
		try {
			return (requireConfig?.("../config/config.js"))?.loadConfig?.().logging;
		} catch {
			return;
		}
	};
	loadConfigFallback = loadConfigFallbackDefault;
}));
//#endregion
//#region src/logging/subsystem.ts
function shouldLogToConsole(level, settings) {
	if (settings.level === "silent") return false;
	return levelToMinLevel(level) <= levelToMinLevel(settings.level);
}
function isRichConsoleEnv() {
	const term = (process.env.TERM ?? "").toLowerCase();
	if (process.env.COLORTERM || process.env.TERM_PROGRAM) return true;
	return term.length > 0 && term !== "dumb";
}
function getColorForConsole() {
	const hasForceColor = typeof process.env.FORCE_COLOR === "string" && process.env.FORCE_COLOR.trim().length > 0 && process.env.FORCE_COLOR.trim() !== "0";
	if (process.env.NO_COLOR && !hasForceColor) return new Chalk({ level: 0 });
	return Boolean(process.stdout.isTTY || process.stderr.isTTY) || isRichConsoleEnv() ? new Chalk({ level: 1 }) : new Chalk({ level: 0 });
}
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
	while (parts.length > 0 && SUBSYSTEM_PREFIXES_TO_DROP.includes(parts[0])) parts.shift();
	if (parts.length === 0) return original;
	if (CHANNEL_SUBSYSTEM_PREFIXES.has(parts[0])) return parts[0];
	if (parts.length > SUBSYSTEM_MAX_SEGMENTS) return parts.slice(-SUBSYSTEM_MAX_SEGMENTS).join("/");
	return parts.join("/");
}
function stripRedundantSubsystemPrefixForConsole(message, displaySubsystem) {
	if (!displaySubsystem) return message;
	if (message.startsWith("[")) {
		const closeIdx = message.indexOf("]");
		if (closeIdx > 1) {
			if (message.slice(1, closeIdx).toLowerCase() === displaySubsystem.toLowerCase()) {
				let i = closeIdx + 1;
				while (message[i] === " ") i += 1;
				return message.slice(i);
			}
		}
	}
	if (message.slice(0, displaySubsystem.length).toLowerCase() !== displaySubsystem.toLowerCase()) return message;
	const next = message.slice(displaySubsystem.length, displaySubsystem.length + 1);
	if (next !== ":" && next !== " ") return message;
	let i = displaySubsystem.length;
	while (message[i] === " ") i += 1;
	if (message[i] === ":") i += 1;
	while (message[i] === " ") i += 1;
	return message.slice(i);
}
function formatConsoleLine(opts) {
	const displaySubsystem = opts.style === "json" ? opts.subsystem : formatSubsystemForConsole(opts.subsystem);
	if (opts.style === "json") return JSON.stringify({
		time: formatConsoleTimestamp("json"),
		level: opts.level,
		subsystem: displaySubsystem,
		message: opts.message,
		...opts.meta
	});
	const color = getColorForConsole();
	const prefix = `[${displaySubsystem}]`;
	const prefixColor = pickSubsystemColor(color, displaySubsystem);
	const levelColor = opts.level === "error" || opts.level === "fatal" ? color.red : opts.level === "warn" ? color.yellow : opts.level === "debug" || opts.level === "trace" ? color.gray : color.cyan;
	const displayMessage = stripRedundantSubsystemPrefixForConsole(opts.message, displaySubsystem);
	return `${[(() => {
		if (opts.style === "pretty") return color.gray(formatConsoleTimestamp("pretty"));
		if (loggingState.consoleTimestampPrefix) return color.gray(formatConsoleTimestamp(opts.style));
		return "";
	})(), prefixColor(prefix)].filter(Boolean).join(" ")} ${levelColor(displayMessage)}`;
}
function writeConsoleLine(level, line) {
	clearActiveProgressLine();
	const sanitized = process.platform === "win32" && process.env.GITHUB_ACTIONS === "true" ? line.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "?").replace(/[\uD800-\uDFFF]/g, "?") : line;
	const sink = loggingState.rawConsole ?? console;
	if (loggingState.forceConsoleToStderr || level === "error" || level === "fatal") (sink.error ?? console.error)(sanitized);
	else if (level === "warn") (sink.warn ?? console.warn)(sanitized);
	else (sink.log ?? console.log)(sanitized);
}
function shouldSuppressProbeConsoleLine(params) {
	if (isVerbose()) return false;
	if (params.level === "error" || params.level === "fatal") return false;
	if (!(params.subsystem === "agent/embedded" || params.subsystem.startsWith("agent/embedded/") || params.subsystem === "model-fallback" || params.subsystem.startsWith("model-fallback/"))) return false;
	if ((typeof params.meta?.runId === "string" ? params.meta.runId : typeof params.meta?.sessionId === "string" ? params.meta.sessionId : void 0)?.startsWith("probe-")) return true;
	return /(sessionId|runId)=probe-/.test(params.message);
}
function logToFile(fileLogger, level, message, meta) {
	if (level === "silent") return;
	const method = fileLogger[level];
	if (typeof method !== "function") return;
	if (meta && Object.keys(meta).length > 0) method.call(fileLogger, meta, message);
	else method.call(fileLogger, message);
}
function createSubsystemLogger(subsystem) {
	let fileLogger = null;
	const getFileLogger = () => {
		if (!fileLogger) fileLogger = getChildLogger({ subsystem });
		return fileLogger;
	};
	const emit = (level, message, meta) => {
		const consoleSettings = getConsoleSettings();
		const consoleEnabled = shouldLogToConsole(level, { level: consoleSettings.level }) && shouldLogSubsystemToConsole(subsystem);
		const fileEnabled = isFileLogLevelEnabled(level);
		if (!consoleEnabled && !fileEnabled) return;
		let consoleMessageOverride;
		let fileMeta = meta;
		if (meta && Object.keys(meta).length > 0) {
			const { consoleMessage, ...rest } = meta;
			if (typeof consoleMessage === "string") consoleMessageOverride = consoleMessage;
			fileMeta = Object.keys(rest).length > 0 ? rest : void 0;
		}
		if (fileEnabled) logToFile(getFileLogger(), level, message, fileMeta);
		if (!consoleEnabled) return;
		const consoleMessage = consoleMessageOverride ?? message;
		if (shouldSuppressProbeConsoleLine({
			level,
			subsystem,
			message: consoleMessage,
			meta: fileMeta
		})) return;
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
			if (target === "console") return isConsoleEnabled(level);
			if (target === "file") return isFileEnabled(level);
			return isConsoleEnabled(level) || isFileEnabled(level);
		},
		trace: (message, meta) => emit("trace", message, meta),
		debug: (message, meta) => emit("debug", message, meta),
		info: (message, meta) => emit("info", message, meta),
		warn: (message, meta) => emit("warn", message, meta),
		error: (message, meta) => emit("error", message, meta),
		fatal: (message, meta) => emit("fatal", message, meta),
		raw: (message) => {
			if (isFileEnabled("info")) logToFile(getFileLogger(), "info", message, { raw: true });
			if (isConsoleEnabled("info")) {
				if (shouldSuppressProbeConsoleLine({
					level: "info",
					subsystem,
					message
				})) return;
				writeConsoleLine("info", message);
			}
		},
		child: (name) => createSubsystemLogger(`${subsystem}/${name}`)
	};
}
var SUBSYSTEM_COLORS, SUBSYSTEM_COLOR_OVERRIDES, SUBSYSTEM_PREFIXES_TO_DROP, SUBSYSTEM_MAX_SEGMENTS, CHANNEL_SUBSYSTEM_PREFIXES;
var init_subsystem = __esmMin((() => {
	init_globals();
	init_runtime();
	init_progress_line();
	init_console();
	init_levels();
	init_logger();
	init_state();
	(() => {
		const getBuiltinModule = process.getBuiltinModule;
		if (typeof getBuiltinModule !== "function") return null;
		try {
			const utilNamespace = getBuiltinModule("util");
			return typeof utilNamespace.inspect === "function" ? utilNamespace.inspect : null;
		} catch {
			return null;
		}
	})();
	SUBSYSTEM_COLORS = [
		"cyan",
		"green",
		"yellow",
		"blue",
		"magenta",
		"red"
	];
	SUBSYSTEM_COLOR_OVERRIDES = { "gmail-watcher": "blue" };
	SUBSYSTEM_PREFIXES_TO_DROP = [
		"gateway",
		"channels",
		"providers"
	];
	SUBSYSTEM_MAX_SEGMENTS = 2;
	CHANNEL_SUBSYSTEM_PREFIXES = new Set([
		"telegram",
		"whatsapp",
		"discord",
		"irc",
		"googlechat",
		"slack",
		"signal",
		"imessage"
	]);
}));
//#endregion
export { warn as C, theme as D, isRich as E, success as S, init_theme as T, isVerbose as _, sanitizeForLog as a, setVerbose as b, defaultRuntime as c, init_progress_line as d, registerActiveProgressLine as f, init_globals as g, info as h, init_ansi as i, init_runtime as l, danger as m, init_subsystem as n, stripAnsi as o, unregisterActiveProgressLine as p, init_console as r, createNonExitingRuntime as s, createSubsystemLogger as t, clearActiveProgressLine as u, logVerbose as v, colorize as w, shouldLogVerbose as x, logVerboseConsole as y };
