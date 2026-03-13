import { o as resolveConfigPath } from "./paths-BfR2LXbA.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import chalk, { Chalk } from "chalk";
import { Logger } from "tslog";
import JSON5 from "json5";
import util from "node:util";
//#region src/daemon/runtime-binary.ts
const NODE_VERSIONED_PATTERN = /^node(?:-\d+|\d+)(?:\.\d+)*(?:\.exe)?$/;
function normalizeRuntimeBasename(execPath) {
	const trimmed = execPath.trim().replace(/^["']|["']$/g, "");
	const lastSlash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
	return (lastSlash === -1 ? trimmed : trimmed.slice(lastSlash + 1)).toLowerCase();
}
function isNodeRuntime(execPath) {
	const base = normalizeRuntimeBasename(execPath);
	return base === "node" || base === "node.exe" || base === "nodejs" || base === "nodejs.exe" || NODE_VERSIONED_PATTERN.test(base);
}
function isBunRuntime(execPath) {
	const base = normalizeRuntimeBasename(execPath);
	return base === "bun" || base === "bun.exe";
}
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
const HELP_FLAGS = new Set(["-h", "--help"]);
const VERSION_FLAGS = new Set(["-V", "--version"]);
const ROOT_VERSION_ALIAS_FLAG = "-v";
function hasHelpOrVersion(argv) {
	return argv.some((arg) => HELP_FLAGS.has(arg) || VERSION_FLAGS.has(arg)) || hasRootVersionAlias(argv);
}
function parsePositiveInt(value) {
	const parsed = Number.parseInt(value, 10);
	if (Number.isNaN(parsed) || parsed <= 0) return;
	return parsed;
}
function hasFlag(argv, name) {
	const args = argv.slice(2);
	for (const arg of args) {
		if (arg === "--") break;
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
		if (arg === "--") break;
		if (arg === ROOT_VERSION_ALIAS_FLAG) {
			hasAlias = true;
			continue;
		}
		const consumed = consumeRootOptionToken(args, i);
		if (consumed > 0) {
			i += consumed - 1;
			continue;
		}
		if (arg.startsWith("-")) continue;
		return false;
	}
	return hasAlias;
}
function isRootVersionInvocation(argv) {
	return isRootInvocationForFlags(argv, VERSION_FLAGS, { includeVersionAlias: true });
}
function isRootInvocationForFlags(argv, targetFlags, options) {
	const args = argv.slice(2);
	let hasTarget = false;
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (!arg) continue;
		if (arg === "--") break;
		if (targetFlags.has(arg) || options?.includeVersionAlias === true && arg === ROOT_VERSION_ALIAS_FLAG) {
			hasTarget = true;
			continue;
		}
		const consumed = consumeRootOptionToken(args, i);
		if (consumed > 0) {
			i += consumed - 1;
			continue;
		}
		return false;
	}
	return hasTarget;
}
function isRootHelpInvocation(argv) {
	return isRootInvocationForFlags(argv, HELP_FLAGS);
}
function getFlagValue(argv, name) {
	const args = argv.slice(2);
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === "--") break;
		if (arg === name) {
			const next = args[i + 1];
			return isValueToken(next) ? next : null;
		}
		if (arg.startsWith(`${name}=`)) {
			const value = arg.slice(name.length + 1);
			return value ? value : null;
		}
	}
}
function getVerboseFlag(argv, options) {
	if (hasFlag(argv, "--verbose")) return true;
	if (options?.includeDebug && hasFlag(argv, "--debug")) return true;
	return false;
}
function getPositiveIntFlagValue(argv, name) {
	const raw = getFlagValue(argv, name);
	if (raw === null || raw === void 0) return raw;
	return parsePositiveInt(raw);
}
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
function getPrimaryCommand(argv) {
	const [primary] = getCommandPathWithRootOptions(argv, 1);
	return primary ?? null;
}
function consumeKnownOptionToken(args, index, booleanFlags, valueFlags) {
	const arg = args[index];
	if (!arg || arg === "--" || !arg.startsWith("-")) return 0;
	const equalsIndex = arg.indexOf("=");
	const flag = equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);
	if (booleanFlags.has(flag)) return equalsIndex === -1 ? 1 : 0;
	if (!valueFlags.has(flag)) return 0;
	if (equalsIndex !== -1) return arg.slice(equalsIndex + 1).trim() ? 1 : 0;
	return isValueToken(args[index + 1]) ? 2 : 0;
}
function getCommandPositionalsWithRootOptions(argv, options) {
	const args = argv.slice(2);
	const commandPath = options.commandPath;
	const booleanFlags = new Set(options.booleanFlags ?? []);
	const valueFlags = new Set(options.valueFlags ?? []);
	const positionals = [];
	let commandIndex = 0;
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (!arg || arg === "--") break;
		const rootConsumed = consumeRootOptionToken(args, i);
		if (rootConsumed > 0) {
			i += rootConsumed - 1;
			continue;
		}
		if (arg.startsWith("-")) {
			const optionConsumed = consumeKnownOptionToken(args, i, booleanFlags, valueFlags);
			if (optionConsumed === 0) return null;
			i += optionConsumed - 1;
			continue;
		}
		if (commandIndex < commandPath.length) {
			if (arg !== commandPath[commandIndex]) return null;
			commandIndex += 1;
			continue;
		}
		positionals.push(arg);
	}
	if (commandIndex < commandPath.length) return null;
	return positionals;
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
function getResolvedLoggerSettings() {
	return resolveSettings();
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
let globalYes = false;
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
function isYes() {
	return globalYes;
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
const graphemeSegmenter = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter(void 0, { granularity: "grapheme" }) : null;
function stripAnsi(input) {
	return input.replace(OSC8_REGEX, "").replace(ANSI_REGEX, "");
}
function splitGraphemes(input) {
	if (!input) return [];
	if (!graphemeSegmenter) return Array.from(input);
	try {
		return Array.from(graphemeSegmenter.segment(input), (segment) => segment.segment);
	} catch {
		return Array.from(input);
	}
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
function isZeroWidthCodePoint(codePoint) {
	return codePoint >= 768 && codePoint <= 879 || codePoint >= 6832 && codePoint <= 6911 || codePoint >= 7616 && codePoint <= 7679 || codePoint >= 8400 && codePoint <= 8447 || codePoint >= 65056 && codePoint <= 65071 || codePoint >= 65024 && codePoint <= 65039 || codePoint === 8205;
}
function isFullWidthCodePoint(codePoint) {
	if (codePoint < 4352) return false;
	return codePoint <= 4447 || codePoint === 9001 || codePoint === 9002 || codePoint >= 11904 && codePoint <= 12871 && codePoint !== 12351 || codePoint >= 12880 && codePoint <= 19903 || codePoint >= 19968 && codePoint <= 42182 || codePoint >= 43360 && codePoint <= 43388 || codePoint >= 44032 && codePoint <= 55203 || codePoint >= 63744 && codePoint <= 64255 || codePoint >= 65040 && codePoint <= 65049 || codePoint >= 65072 && codePoint <= 65131 || codePoint >= 65281 && codePoint <= 65376 || codePoint >= 65504 && codePoint <= 65510 || codePoint >= 110576 && codePoint <= 110579 || codePoint >= 110581 && codePoint <= 110587 || codePoint >= 110589 && codePoint <= 110590 || codePoint >= 110592 && codePoint <= 111359 || codePoint >= 127488 && codePoint <= 127569 || codePoint >= 131072 && codePoint <= 262141;
}
const emojiLikePattern = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u;
function graphemeWidth(grapheme) {
	if (!grapheme) return 0;
	if (emojiLikePattern.test(grapheme)) return 2;
	let sawPrintable = false;
	for (const char of grapheme) {
		const codePoint = char.codePointAt(0);
		if (codePoint == null) continue;
		if (isZeroWidthCodePoint(codePoint)) continue;
		if (isFullWidthCodePoint(codePoint)) return 2;
		sawPrintable = true;
	}
	return sawPrintable ? 1 : 0;
}
function visibleWidth(input) {
	return splitGraphemes(stripAnsi(input)).reduce((sum, grapheme) => sum + graphemeWidth(grapheme), 0);
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
	if (!filter || filter.length === 0) return true;
	return filter.some((prefix) => subsystem === prefix || subsystem.startsWith(`${prefix}/`));
}
const SUPPRESSED_CONSOLE_PREFIXES = [
	"Closing session:",
	"Opening session:",
	"Removing old closed session:",
	"Session already closed",
	"Session already open"
];
function shouldSuppressConsoleMessage(message) {
	if (isVerbose()) return false;
	if (SUPPRESSED_CONSOLE_PREFIXES.some((prefix) => message.startsWith(prefix))) return true;
	if (message.startsWith("[EventQueue] Slow listener detected") && message.includes("DiscordMessageListener")) return true;
	return false;
}
function isEpipeError(err) {
	const code = err?.code;
	return code === "EPIPE" || code === "EIO";
}
function formatConsoleTimestamp(style) {
	const now = /* @__PURE__ */ new Date();
	if (style === "pretty") return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
	return formatLocalIsoWithOffset(now);
}
function hasTimestampPrefix(value) {
	return /^(?:\d{2}:\d{2}:\d{2}|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)/.test(value);
}
function isJsonPayload(value) {
	const trimmed = value.trim();
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
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
		const timestamp = loggingState.consoleTimestampPrefix && trimmed.length > 0 && !hasTimestampPrefix(trimmed) && !isJsonPayload(trimmed) ? formatConsoleTimestamp(getConsoleSettings().style) : "";
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
			const line = timestamp ? `${timestamp} ${formatted}` : formatted;
			process.stderr.write(`${line}\n`);
		} catch (err) {
			if (isEpipeError(err)) return;
			throw err;
		}
		else try {
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
//#region src/logging/subsystem.ts
function shouldLogToConsole(level, settings) {
	if (settings.level === "silent") return false;
	return levelToMinLevel(level) <= levelToMinLevel(settings.level);
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
function runtimeForLogger(logger, exit = defaultRuntime.exit) {
	const formatArgs = (...args) => args.map((arg) => formatRuntimeArg(arg)).join(" ").trim();
	return {
		log: (...args) => logger.info(formatArgs(...args)),
		error: (...args) => logger.error(formatArgs(...args)),
		exit
	};
}
//#endregion
export { isRootHelpInvocation as $, theme as A, tryParseLogLevel as B, logVerboseConsole as C, warn as D, success as E, formatLocalIsoWithOffset as F, getCommandPositionalsWithRootOptions as G, resolvePreferredOpenClawTmpDir as H, isValidTimeZone as I, getPrimaryCommand as J, getFlagValue as K, resolveNodeRequireFromMeta as L, getLogger as M, getResolvedLoggerSettings as N, colorize as O, toPinoLikeLogger as P, hasRootVersionAlias as Q, ALLOWED_LOG_LEVELS as R, logVerbose as S, shouldLogVerbose as T, buildParseArgv as U, readLoggingConfig as V, getCommandPathWithRootOptions as W, hasFlag as X, getVerboseFlag as Y, hasHelpOrVersion as Z, unregisterActiveProgressLine as _, setConsoleSubsystemFilter as a, isNodeRuntime as at, isVerbose as b, sanitizeForLog as c, visibleWidth as d, isRootVersionInvocation as et, createNonExitingRuntime as f, registerActiveProgressLine as g, clearActiveProgressLine as h, routeLogsToStderr as i, isBunRuntime as it, getChildLogger as j, isRich as k, splitGraphemes as l, restoreTerminalState as m, runtimeForLogger as n, consumeRootOptionToken as nt, setConsoleTimestampPrefix as o, defaultRuntime as p, getPositiveIntFlagValue as q, enableConsoleCapture as r, isValueToken as rt, shouldLogSubsystemToConsole as s, createSubsystemLogger as t, shouldMigrateStateFromPath as tt, stripAnsi as u, danger as v, setVerbose as w, isYes as x, info as y, normalizeLogLevel as z };
