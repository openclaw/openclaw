import { r as resolveConfigPath } from "./paths-hfkBoC7i.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import chalk, { Chalk } from "chalk";
import { Logger } from "tslog";
import JSON5 from "json5";
import "node:util";
const ROOT_BOOLEAN_FLAGS = new Set(["--dev", "--no-color"]);
const ROOT_VALUE_FLAGS = new Set(["--profile", "--log-level"]);
function isValueToken(arg) {
	if (!arg || arg === "--") return false;
	if (!arg.startsWith("-")) return true;
	return /^-\d+(?:\.\d+)?$/.test(arg);
}
function consumeRootOptionToken(args, index) {
	const arg = args[index];
	if (!arg) return 0;
	if (ROOT_BOOLEAN_FLAGS.has(arg)) return 1;
	if (arg.startsWith("--profile=") || arg.startsWith("--log-level=")) return 1;
	if (ROOT_VALUE_FLAGS.has(arg)) return isValueToken(args[index + 1]) ? 2 : 1;
	return 0;
}
//#endregion
//#region src/cli/argv.ts
function getCommandPathWithRootOptions(argv, depth = 2) {
	return getCommandPathInternal(argv, depth, { skipRootOptions: true });
}
function getCommandPathInternal(argv, depth, opts) {
	const args = argv.slice(2);
	const path = [];
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (!arg) continue;
		if (arg === "--") break;
		if (opts.skipRootOptions) {
			const consumed = consumeRootOptionToken(args, i);
			if (consumed > 0) {
				i += consumed - 1;
				continue;
			}
		}
		if (arg.startsWith("-")) continue;
		path.push(arg);
		if (path.length >= depth) break;
	}
	return path;
}
//#endregion
//#region src/infra/tmp-openclaw-dir.ts
const POSIX_OPENCLAW_TMP_DIR = "/tmp/openclaw";
const TMP_DIR_ACCESS_MODE = fs.constants.W_OK | fs.constants.X_OK;
function isNodeErrorWithCode(err, code) {
	return typeof err === "object" && err !== null && "code" in err && err.code === code;
}
function resolvePreferredOpenClawTmpDir(options = {}) {
	const accessSync = options.accessSync ?? fs.accessSync;
	const chmodSync = options.chmodSync ?? fs.chmodSync;
	const lstatSync = options.lstatSync ?? fs.lstatSync;
	const mkdirSync = options.mkdirSync ?? fs.mkdirSync;
	const warn = options.warn ?? ((message) => console.warn(message));
	const getuid = options.getuid ?? (() => {
		try {
			return typeof process.getuid === "function" ? process.getuid() : void 0;
		} catch {
			return;
		}
	});
	const tmpdir = options.tmpdir ?? os.tmpdir;
	const uid = getuid();
	const isSecureDirForUser = (st) => {
		if (uid === void 0) return true;
		if (typeof st.uid === "number" && st.uid !== uid) return false;
		if (typeof st.mode === "number" && (st.mode & 18) !== 0) return false;
		return true;
	};
	const fallback = () => {
		const base = tmpdir();
		const suffix = uid === void 0 ? "openclaw" : `openclaw-${uid}`;
		return path.join(base, suffix);
	};
	const isTrustedTmpDir = (st) => {
		return st.isDirectory() && !st.isSymbolicLink() && isSecureDirForUser(st);
	};
	const resolveDirState = (candidatePath) => {
		try {
			if (!isTrustedTmpDir(lstatSync(candidatePath))) return "invalid";
			accessSync(candidatePath, TMP_DIR_ACCESS_MODE);
			return "available";
		} catch (err) {
			if (isNodeErrorWithCode(err, "ENOENT")) return "missing";
			return "invalid";
		}
	};
	const tryRepairWritableBits = (candidatePath) => {
		try {
			const st = lstatSync(candidatePath);
			if (!st.isDirectory() || st.isSymbolicLink()) return false;
			if (uid !== void 0 && typeof st.uid === "number" && st.uid !== uid) return false;
			if (typeof st.mode !== "number" || (st.mode & 18) === 0) return false;
			chmodSync(candidatePath, 448);
			warn(`[openclaw] tightened permissions on temp dir: ${candidatePath}`);
			return resolveDirState(candidatePath) === "available";
		} catch {
			return false;
		}
	};
	const ensureTrustedFallbackDir = () => {
		const fallbackPath = fallback();
		const state = resolveDirState(fallbackPath);
		if (state === "available") return fallbackPath;
		if (state === "invalid") {
			if (tryRepairWritableBits(fallbackPath)) return fallbackPath;
			throw new Error(`Unsafe fallback OpenClaw temp dir: ${fallbackPath}`);
		}
		try {
			mkdirSync(fallbackPath, {
				recursive: true,
				mode: 448
			});
			chmodSync(fallbackPath, 448);
		} catch {
			throw new Error(`Unable to create fallback OpenClaw temp dir: ${fallbackPath}`);
		}
		if (resolveDirState(fallbackPath) !== "available" && !tryRepairWritableBits(fallbackPath)) throw new Error(`Unsafe fallback OpenClaw temp dir: ${fallbackPath}`);
		return fallbackPath;
	};
	const existingPreferredState = resolveDirState(POSIX_OPENCLAW_TMP_DIR);
	if (existingPreferredState === "available") return POSIX_OPENCLAW_TMP_DIR;
	if (existingPreferredState === "invalid") {
		if (tryRepairWritableBits("/tmp/openclaw")) return POSIX_OPENCLAW_TMP_DIR;
		return ensureTrustedFallbackDir();
	}
	try {
		accessSync("/tmp", TMP_DIR_ACCESS_MODE);
		mkdirSync(POSIX_OPENCLAW_TMP_DIR, {
			recursive: true,
			mode: 448
		});
		chmodSync(POSIX_OPENCLAW_TMP_DIR, 448);
		if (resolveDirState("/tmp/openclaw") !== "available" && !tryRepairWritableBits("/tmp/openclaw")) return ensureTrustedFallbackDir();
		return POSIX_OPENCLAW_TMP_DIR;
	} catch {
		return ensureTrustedFallbackDir();
	}
}
//#endregion
//#region src/logging/config.ts
function readLoggingConfig() {
	const configPath = resolveConfigPath();
	try {
		if (!fs.existsSync(configPath)) return;
		const raw = fs.readFileSync(configPath, "utf-8");
		const logging = JSON5.parse(raw)?.logging;
		if (!logging || typeof logging !== "object" || Array.isArray(logging)) return;
		return logging;
	} catch {
		return;
	}
}
//#endregion
//#region src/logging/levels.ts
const ALLOWED_LOG_LEVELS = [
	"silent",
	"fatal",
	"error",
	"warn",
	"info",
	"debug",
	"trace"
];
function tryParseLogLevel(level) {
	if (typeof level !== "string") return;
	const candidate = level.trim();
	return ALLOWED_LOG_LEVELS.includes(candidate) ? candidate : void 0;
}
function normalizeLogLevel(level, fallback = "info") {
	return tryParseLogLevel(level) ?? fallback;
}
function levelToMinLevel(level) {
	return {
		fatal: 0,
		error: 1,
		warn: 2,
		info: 3,
		debug: 4,
		trace: 5,
		silent: Number.POSITIVE_INFINITY
	}[level];
}
//#endregion
//#region src/logging/state.ts
const loggingState = {
	cachedLogger: null,
	cachedSettings: null,
	cachedConsoleSettings: null,
	overrideSettings: null,
	invalidEnvLogLevelValue: null,
	consolePatched: false,
	forceConsoleToStderr: false,
	consoleTimestampPrefix: false,
	consoleSubsystemFilter: null,
	resolvingConsoleSettings: false,
	streamErrorHandlersInstalled: false,
	rawConsole: null
};
//#endregion
//#region src/logging/env-log-level.ts
function resolveEnvLogLevelOverride() {
	const raw = process.env.OPENCLAW_LOG_LEVEL;
	const trimmed = typeof raw === "string" ? raw.trim() : "";
	if (!trimmed) {
		loggingState.invalidEnvLogLevelValue = null;
		return;
	}
	const parsed = tryParseLogLevel(trimmed);
	if (parsed) {
		loggingState.invalidEnvLogLevelValue = null;
		return parsed;
	}
	if (loggingState.invalidEnvLogLevelValue !== trimmed) {
		loggingState.invalidEnvLogLevelValue = trimmed;
		process.stderr.write(`[openclaw] Ignoring invalid OPENCLAW_LOG_LEVEL="${trimmed}" (allowed: ${ALLOWED_LOG_LEVELS.join("|")}).\n`);
	}
}
//#endregion
//#region src/logging/node-require.ts
function resolveNodeRequireFromMeta(metaUrl) {
	const getBuiltinModule = process.getBuiltinModule;
	if (typeof getBuiltinModule !== "function") return null;
	try {
		const moduleNamespace = getBuiltinModule("module");
		const createRequire = typeof moduleNamespace.createRequire === "function" ? moduleNamespace.createRequire : null;
		return createRequire ? createRequire(metaUrl) : null;
	} catch {
		return null;
	}
}
//#endregion
//#region src/logging/timestamps.ts
function isValidTimeZone(tz) {
	try {
		new Intl.DateTimeFormat("en", { timeZone: tz });
		return true;
	} catch {
		return false;
	}
}
function formatLocalIsoWithOffset(now, timeZone) {
	const explicit = timeZone ?? process.env.TZ;
	const tz = explicit && isValidTimeZone(explicit) ? explicit : Intl.DateTimeFormat().resolvedOptions().timeZone;
	const fmt = new Intl.DateTimeFormat("en", {
		timeZone: tz,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
		fractionalSecondDigits: 3,
		timeZoneName: "longOffset"
	});
	const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
	const offsetRaw = parts.timeZoneName ?? "GMT";
	const offset = offsetRaw === "GMT" ? "+00:00" : offsetRaw.slice(3);
	return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${parts.fractionalSecond}${offset}`;
}
//#endregion
//#region src/logging/logger.ts
const DEFAULT_LOG_DIR = resolvePreferredOpenClawTmpDir();
path.join(DEFAULT_LOG_DIR, "openclaw.log");
const LOG_PREFIX = "openclaw";
const LOG_SUFFIX = ".log";
const MAX_LOG_AGE_MS = 1440 * 60 * 1e3;
const DEFAULT_MAX_LOG_FILE_BYTES = 500 * 1024 * 1024;
const requireConfig$1 = resolveNodeRequireFromMeta(import.meta.url);
const externalTransports = /* @__PURE__ */ new Set();
function shouldSkipLoadConfigFallback(argv = process.argv) {
	const [primary, secondary] = getCommandPathWithRootOptions(argv, 2);
	return primary === "config" && secondary === "validate";
}
function attachExternalTransport(logger, transport) {
	logger.attachTransport((logObj) => {
		if (!externalTransports.has(transport)) return;
		try {
			transport(logObj);
		} catch {}
	});
}
function canUseSilentVitestFileLogFastPath(envLevel) {
	return process.env.VITEST === "true" && process.env.OPENCLAW_TEST_FILE_LOG !== "1" && !envLevel && !loggingState.overrideSettings;
}
function resolveSettings() {
	const envLevel = resolveEnvLogLevelOverride();
	if (canUseSilentVitestFileLogFastPath(envLevel)) return {
		level: "silent",
		file: defaultRollingPathForToday(),
		maxFileBytes: DEFAULT_MAX_LOG_FILE_BYTES
	};
	let cfg = loggingState.overrideSettings ?? readLoggingConfig();
	if (!cfg && !shouldSkipLoadConfigFallback()) try {
		cfg = (requireConfig$1?.("../config/config.js"))?.loadConfig?.().logging;
	} catch {
		cfg = void 0;
	}
	const defaultLevel = process.env.VITEST === "true" && process.env.OPENCLAW_TEST_FILE_LOG !== "1" ? "silent" : "info";
	const fromConfig = normalizeLogLevel(cfg?.level, defaultLevel);
	return {
		level: envLevel ?? fromConfig,
		file: cfg?.file ?? defaultRollingPathForToday(),
		maxFileBytes: resolveMaxLogFileBytes(cfg?.maxFileBytes)
	};
}
function settingsChanged(a, b) {
	if (!a) return true;
	return a.level !== b.level || a.file !== b.file || a.maxFileBytes !== b.maxFileBytes;
}
function isFileLogLevelEnabled(level) {
	const settings = loggingState.cachedSettings ?? resolveSettings();
	if (!loggingState.cachedSettings) loggingState.cachedSettings = settings;
	if (settings.level === "silent") return false;
	return levelToMinLevel(level) <= levelToMinLevel(settings.level);
}
function buildLogger(settings) {
	const logger = new Logger({
		name: "openclaw",
		minLevel: levelToMinLevel(settings.level),
		type: "hidden"
	});
	if (settings.level === "silent") {
		for (const transport of externalTransports) attachExternalTransport(logger, transport);
		return logger;
	}
	fs.mkdirSync(path.dirname(settings.file), { recursive: true });
	if (isRollingPath(settings.file)) pruneOldRollingLogs(path.dirname(settings.file));
	let currentFileBytes = getCurrentLogFileBytes(settings.file);
	let warnedAboutSizeCap = false;
	logger.attachTransport((logObj) => {
		try {
			const time = formatLocalIsoWithOffset(logObj.date ?? /* @__PURE__ */ new Date());
			const payload = `${JSON.stringify({
				...logObj,
				time
			})}\n`;
			const payloadBytes = Buffer.byteLength(payload, "utf8");
			const nextBytes = currentFileBytes + payloadBytes;
			if (nextBytes > settings.maxFileBytes) {
				if (!warnedAboutSizeCap) {
					warnedAboutSizeCap = true;
					const warningLine = JSON.stringify({
						time: formatLocalIsoWithOffset(/* @__PURE__ */ new Date()),
						level: "warn",
						subsystem: "logging",
						message: `log file size cap reached; suppressing writes file=${settings.file} maxFileBytes=${settings.maxFileBytes}`
					});
					appendLogLine(settings.file, `${warningLine}\n`);
					process.stderr.write(`[openclaw] log file size cap reached; suppressing writes file=${settings.file} maxFileBytes=${settings.maxFileBytes}\n`);
				}
				return;
			}
			if (appendLogLine(settings.file, payload)) currentFileBytes = nextBytes;
		} catch {}
	});
	for (const transport of externalTransports) attachExternalTransport(logger, transport);
	return logger;
}
function resolveMaxLogFileBytes(raw) {
	if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return Math.floor(raw);
	return DEFAULT_MAX_LOG_FILE_BYTES;
}
function getCurrentLogFileBytes(file) {
	try {
		return fs.statSync(file).size;
	} catch {
		return 0;
	}
}
function appendLogLine(file, line) {
	try {
		fs.appendFileSync(file, line, { encoding: "utf8" });
		return true;
	} catch {
		return false;
	}
}
function getLogger() {
	const settings = resolveSettings();
	const cachedLogger = loggingState.cachedLogger;
	const cachedSettings = loggingState.cachedSettings;
	if (!cachedLogger || settingsChanged(cachedSettings, settings)) {
		loggingState.cachedLogger = buildLogger(settings);
		loggingState.cachedSettings = settings;
	}
	return loggingState.cachedLogger;
}
function getChildLogger(bindings, opts) {
	const base = getLogger();
	const minLevel = opts?.level ? levelToMinLevel(opts.level) : void 0;
	const name = bindings ? JSON.stringify(bindings) : void 0;
	return base.getSubLogger({
		name,
		minLevel,
		prefix: bindings ? [name ?? ""] : []
	});
}
function toPinoLikeLogger(logger, level) {
	const buildChild = (bindings) => toPinoLikeLogger(logger.getSubLogger({ name: bindings ? JSON.stringify(bindings) : void 0 }), level);
	return {
		level,
		child: buildChild,
		trace: (...args) => logger.trace(...args),
		debug: (...args) => logger.debug(...args),
		info: (...args) => logger.info(...args),
		warn: (...args) => logger.warn(...args),
		error: (...args) => logger.error(...args),
		fatal: (...args) => logger.fatal(...args)
	};
}
function formatLocalDate(date) {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function defaultRollingPathForToday() {
	const today = formatLocalDate(/* @__PURE__ */ new Date());
	return path.join(DEFAULT_LOG_DIR, `${LOG_PREFIX}-${today}${LOG_SUFFIX}`);
}
function isRollingPath(file) {
	const base = path.basename(file);
	return base.startsWith(`${LOG_PREFIX}-`) && base.endsWith(LOG_SUFFIX) && base.length === `${LOG_PREFIX}-YYYY-MM-DD${LOG_SUFFIX}`.length;
}
function pruneOldRollingLogs(dir) {
	try {
		const entries = fs.readdirSync(dir, { withFileTypes: true });
		const cutoff = Date.now() - MAX_LOG_AGE_MS;
		for (const entry of entries) {
			if (!entry.isFile()) continue;
			if (!entry.name.startsWith(`${LOG_PREFIX}-`) || !entry.name.endsWith(LOG_SUFFIX)) continue;
			const fullPath = path.join(dir, entry.name);
			try {
				if (fs.statSync(fullPath).mtimeMs < cutoff) fs.rmSync(fullPath, { force: true });
			} catch {}
		}
	} catch {}
}
//#endregion
//#region src/terminal/palette.ts
const LOBSTER_PALETTE = {
	accent: "#FF5A2D",
	accentBright: "#FF7A3D",
	accentDim: "#D14A22",
	info: "#FF8A5B",
	success: "#2FBF71",
	warn: "#FFB020",
	error: "#E23D2D",
	muted: "#8B7F77"
};
//#endregion
//#region src/terminal/theme.ts
const hasForceColor = typeof process.env.FORCE_COLOR === "string" && process.env.FORCE_COLOR.trim().length > 0 && process.env.FORCE_COLOR.trim() !== "0";
const baseChalk = process.env.NO_COLOR && !hasForceColor ? new Chalk({ level: 0 }) : chalk;
const hex = (value) => baseChalk.hex(value);
const theme = {
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
const isRich = () => Boolean(baseChalk.level > 0);
const colorize = (rich, color, value) => rich ? color(value) : value;
//#endregion
//#region src/globals.ts
let globalVerbose = false;
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
const success = theme.success;
const warn = theme.warn;
const info = theme.info;
const danger = theme.error;
//#endregion
//#region src/terminal/progress-line.ts
let activeStream = null;
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
//#region src/terminal/ansi.ts
const ANSI_SGR_PATTERN = "\\x1b\\[[0-9;]*m";
const OSC8_PATTERN = "\\x1b\\]8;;.*?\\x1b\\\\|\\x1b\\]8;;\\x1b\\\\";
const ANSI_REGEX = new RegExp(ANSI_SGR_PATTERN, "g");
const OSC8_REGEX = new RegExp(OSC8_PATTERN, "g");
typeof Intl !== "undefined" && "Segmenter" in Intl && new Intl.Segmenter(void 0, { granularity: "grapheme" });
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
//#endregion
//#region src/logging/subsystem.ts
function shouldLogToConsole(level, settings) {
	if (settings.level === "silent") return false;
	return levelToMinLevel(level) <= levelToMinLevel(settings.level);
}
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
//#endregion
export { resolveNodeRequireFromMeta as C, consumeRootOptionToken as D, resolvePreferredOpenClawTmpDir as E, toPinoLikeLogger as S, readLoggingConfig as T, colorize as _, defaultRuntime as a, getChildLogger as b, unregisterActiveProgressLine as c, logVerbose as d, logVerboseConsole as f, warn as g, success as h, createNonExitingRuntime as i, danger as l, shouldLogVerbose as m, sanitizeForLog as n, clearActiveProgressLine as o, setVerbose as p, stripAnsi as r, registerActiveProgressLine as s, createSubsystemLogger as t, info as u, isRich as v, normalizeLogLevel as w, getLogger as x, theme as y };
