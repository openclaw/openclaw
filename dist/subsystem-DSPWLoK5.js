import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { s as redactSensitiveText } from "./redact-ok5Q8nmw.js";
import { t as clearActiveProgressLine } from "./progress-line-C1NvDnL7.js";
import { n as defaultRuntime } from "./runtime-yzlkhCoS.js";
import { t as isVerbose } from "./global-state-BAD7XgmL.js";
import { _ as levelToMinLevel, o as isFileLogLevelEnabled, r as getChildLogger } from "./logger-Dg9dVaLI.js";
import { t as loggingState } from "./state-CHRYWIGY.js";
import { l as shouldLogSubsystemToConsole, n as formatConsoleTimestamp, r as getConsoleSettings } from "./console-BAPPAj56.js";
import { Chalk } from "chalk";
//#region src/logging/subsystem.ts
function normalizeSubsystemLabel(subsystem) {
	if (typeof subsystem !== "string") return "unknown";
	const normalized = subsystem.trim();
	return normalized.length > 0 ? normalized : "unknown";
}
function shouldLogToConsole(level, settings) {
	if (level === "silent") return false;
	if (settings.level === "silent") return false;
	return levelToMinLevel(level) >= levelToMinLevel(settings.level);
}
const inspectValue = (() => {
	const getBuiltinModule = process.getBuiltinModule;
	if (typeof getBuiltinModule !== "function") return null;
	try {
		const utilNamespace = getBuiltinModule("util");
		return typeof utilNamespace.inspect === "function" ? utilNamespace.inspect : null;
	} catch {
		return null;
	}
})();
function formatRuntimeArg(arg) {
	if (typeof arg === "string") return arg;
	if (inspectValue) return inspectValue(arg);
	try {
		return JSON.stringify(arg);
	} catch {
		return String(arg);
	}
}
function isRichConsoleEnv() {
	const term = normalizeLowercaseStringOrEmpty(process.env.TERM);
	if (process.env.COLORTERM || process.env.TERM_PROGRAM) return true;
	return term.length > 0 && term !== "dumb";
}
function getColorForConsole() {
	const hasForceColor = typeof process.env.FORCE_COLOR === "string" && process.env.FORCE_COLOR.trim().length > 0 && process.env.FORCE_COLOR.trim() !== "0";
	if (hasForceColor) return new Chalk({ level: 1 });
	if (process.env.NO_COLOR && !hasForceColor) return new Chalk({ level: 0 });
	return process.stdout.isTTY || process.stderr.isTTY || isRichConsoleEnv() ? new Chalk({ level: 1 }) : new Chalk({ level: 0 });
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
const SUBSYSTEM_PREFIXES_TO_DROP = [
	"gateway",
	"channels",
	"providers"
];
const SUBSYSTEM_MAX_SEGMENTS = 2;
const CHANNEL_SUBSYSTEM_PREFIXES = new Set([
	"clickclack",
	"discord",
	"feishu",
	"googlechat",
	"imessage",
	"irc",
	"line",
	"matrix",
	"mattermost",
	"msteams",
	"nextcloud-talk",
	"nostr",
	"openclaw-weixin",
	"qqbot",
	"signal",
	"slack",
	"synology-chat",
	"telegram",
	"tlon",
	"twitch",
	"webchat",
	"wecom",
	"whatsapp",
	"yuanbao",
	"zalo",
	"zalouser"
]);
function isChannelSubsystemPrefix(value) {
	const normalized = normalizeLowercaseStringOrEmpty(value);
	if (!normalized) return false;
	return CHANNEL_SUBSYSTEM_PREFIXES.has(normalized);
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
	if (isChannelSubsystemPrefix(parts[0])) return parts[0];
	if (parts.length > SUBSYSTEM_MAX_SEGMENTS) return parts.slice(-2).join("/");
	return parts.join("/");
}
function stripRedundantSubsystemPrefixForConsole(message, displaySubsystem) {
	if (!displaySubsystem) return message;
	if (message.startsWith("[")) {
		const closeIdx = message.indexOf("]");
		if (closeIdx > 1) {
			if (normalizeLowercaseStringOrEmpty(message.slice(1, closeIdx)) === normalizeLowercaseStringOrEmpty(displaySubsystem)) {
				let i = closeIdx + 1;
				while (message[i] === " ") i += 1;
				return message.slice(i);
			}
		}
	}
	if (normalizeLowercaseStringOrEmpty(message.slice(0, displaySubsystem.length)) !== normalizeLowercaseStringOrEmpty(displaySubsystem)) return message;
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
	if (opts.style === "json") return redactSensitiveText(JSON.stringify({
		time: formatConsoleTimestamp("json"),
		level: opts.level,
		subsystem: displaySubsystem,
		message: opts.message,
		...opts.meta
	}));
	const color = getColorForConsole();
	const prefix = `[${displaySubsystem}]`;
	const prefixColor = pickSubsystemColor(color, displaySubsystem);
	const levelColor = opts.level === "error" || opts.level === "fatal" ? color.red : opts.level === "warn" ? color.yellow : opts.level === "debug" || opts.level === "trace" ? color.gray : color.cyan;
	const displayMessage = stripRedundantSubsystemPrefixForConsole(redactSensitiveText(opts.message), displaySubsystem);
	return `${[(() => {
		if (opts.style === "pretty") return color.gray(formatConsoleTimestamp("pretty"));
		if (loggingState.consoleTimestampPrefix) return color.gray(formatConsoleTimestamp(opts.style));
		return "";
	})(), prefixColor(prefix)].filter(Boolean).join(" ")} ${levelColor(displayMessage)}`;
}
function writeConsoleLine(level, line, opts = {}) {
	clearActiveProgressLine();
	const sanitized = process.platform === "win32" && process.env.GITHUB_ACTIONS === "true" ? line.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "?").replace(/[\uD800-\uDFFF]/g, "?") : line;
	const redacted = opts.redacted ? sanitized : redactSensitiveText(sanitized);
	const sink = loggingState.rawConsole ?? console;
	if (loggingState.forceConsoleToStderr || level === "error" || level === "fatal") (sink.error ?? console.error)(redacted);
	else if (level === "warn") (sink.warn ?? console.warn)(redacted);
	else (sink.log ?? console.log)(redacted);
}
function shouldSuppressProbeConsoleLine(params) {
	if (isVerbose()) return false;
	if (params.level === "error" || params.level === "fatal") return false;
	const subsystem = normalizeSubsystemLabel(params.subsystem);
	const message = typeof params.message === "string" ? params.message : "";
	if (!(subsystem === "agent/embedded" || subsystem.startsWith("agent/embedded/") || subsystem === "model-fallback" || subsystem.startsWith("model-fallback/"))) return false;
	if ((typeof params.meta?.runId === "string" ? params.meta.runId : typeof params.meta?.sessionId === "string" ? params.meta.sessionId : void 0)?.startsWith("probe-")) return true;
	return /(sessionId|runId)=probe-/.test(message);
}
function logToFile(fileLogger, level, message, meta) {
	if (level === "silent") return;
	const method = fileLogger[level];
	if (typeof method !== "function") return;
	if (meta && Object.keys(meta).length > 0) method.call(fileLogger, meta, message);
	else method.call(fileLogger, message);
}
function createSubsystemLogger(subsystem) {
	const resolvedSubsystem = normalizeSubsystemLabel(subsystem);
	const emitLog = (level, message, meta) => {
		const consoleSettings = getConsoleSettings();
		const consoleEnabled = shouldLogToConsole(level, { level: consoleSettings.level }) && shouldLogSubsystemToConsole(resolvedSubsystem);
		const fileEnabled = isFileLogLevelEnabled(level);
		if (!consoleEnabled && !fileEnabled) return;
		let consoleMessageOverride;
		let fileMeta = meta;
		if (meta && Object.keys(meta).length > 0) {
			const { consoleMessage, ...rest } = meta;
			if (typeof consoleMessage === "string") consoleMessageOverride = consoleMessage;
			fileMeta = Object.keys(rest).length > 0 ? rest : void 0;
		}
		if (fileEnabled) logToFile(getChildLogger({ subsystem: resolvedSubsystem }), level, message, fileMeta);
		if (!consoleEnabled) return;
		const consoleMessage = consoleMessageOverride ?? message;
		if (shouldSuppressProbeConsoleLine({
			level,
			subsystem: resolvedSubsystem,
			message: consoleMessage,
			meta: fileMeta
		})) return;
		writeConsoleLine(level, formatConsoleLine({
			level,
			subsystem: resolvedSubsystem,
			message: consoleSettings.style === "json" ? message : consoleMessage,
			style: consoleSettings.style,
			meta: fileMeta
		}), { redacted: true });
	};
	return {
		subsystem: resolvedSubsystem,
		isEnabled(level, target = "any") {
			const isConsoleEnabled = shouldLogToConsole(level, { level: getConsoleSettings().level }) && shouldLogSubsystemToConsole(resolvedSubsystem);
			const isFileEnabled = isFileLogLevelEnabled(level);
			if (target === "console") return isConsoleEnabled;
			if (target === "file") return isFileEnabled;
			return isConsoleEnabled || isFileEnabled;
		},
		trace(message, meta) {
			emitLog("trace", message, meta);
		},
		debug(message, meta) {
			emitLog("debug", message, meta);
		},
		info(message, meta) {
			emitLog("info", message, meta);
		},
		warn(message, meta) {
			emitLog("warn", message, meta);
		},
		error(message, meta) {
			emitLog("error", message, meta);
		},
		fatal(message, meta) {
			emitLog("fatal", message, meta);
		},
		raw(message) {
			if (isFileLogLevelEnabled("info")) logToFile(getChildLogger({ subsystem: resolvedSubsystem }), "info", message, { raw: true });
			if (shouldLogToConsole("info", { level: getConsoleSettings().level }) && shouldLogSubsystemToConsole(resolvedSubsystem)) {
				if (shouldSuppressProbeConsoleLine({
					level: "info",
					subsystem: resolvedSubsystem,
					message
				})) return;
				writeConsoleLine("info", message);
			}
		},
		child(name) {
			return createSubsystemLogger(`${resolvedSubsystem}/${name}`);
		}
	};
}
function runtimeForLogger(logger, exit = defaultRuntime.exit) {
	return {
		log(...args) {
			logger.info(args.map((arg) => formatRuntimeArg(arg)).join(" ").trim());
		},
		error(...args) {
			logger.error(args.map((arg) => formatRuntimeArg(arg)).join(" ").trim());
		},
		writeStdout(value) {
			logger.info(value);
		},
		writeJson(value, space = 2) {
			logger.info(JSON.stringify(value, null, space > 0 ? space : void 0));
		},
		exit
	};
}
function createSubsystemRuntime(subsystem, exit = defaultRuntime.exit) {
	return runtimeForLogger(createSubsystemLogger(subsystem), exit);
}
//#endregion
export { stripRedundantSubsystemPrefixForConsole as i, createSubsystemRuntime as n, runtimeForLogger as r, createSubsystemLogger as t };
