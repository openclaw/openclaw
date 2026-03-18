import { n as __esmMin } from "./chunk-DORXReHP.js";
import { n as init_tmp_openclaw_dir, r as resolvePreferredOpenClawTmpDir, t as POSIX_OPENCLAW_TMP_DIR } from "./tmp-openclaw-dir-DgEKZnX6.js";
import { i as resolveConfigPath, r as init_paths } from "./paths-CbmqEZIn.js";
import fs from "node:fs";
import path from "node:path";
import { Logger } from "tslog";
import json5 from "json5";
//#region src/infra/cli-root-options.ts
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
var ROOT_BOOLEAN_FLAGS, ROOT_VALUE_FLAGS;
var init_cli_root_options = __esmMin((() => {
	ROOT_BOOLEAN_FLAGS = new Set(["--dev", "--no-color"]);
	ROOT_VALUE_FLAGS = new Set(["--profile", "--log-level"]);
}));
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
var init_argv = __esmMin((() => {
	init_cli_root_options();
}));
//#endregion
//#region src/logging/config.ts
function readLoggingConfig() {
	const configPath = resolveConfigPath();
	try {
		if (!fs.existsSync(configPath)) return;
		const raw = fs.readFileSync(configPath, "utf-8");
		const logging = json5.parse(raw)?.logging;
		if (!logging || typeof logging !== "object" || Array.isArray(logging)) return;
		return logging;
	} catch {
		return;
	}
}
var init_config = __esmMin((() => {
	init_paths();
}));
//#endregion
//#region src/logging/levels.ts
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
var ALLOWED_LOG_LEVELS;
var init_levels = __esmMin((() => {
	ALLOWED_LOG_LEVELS = [
		"silent",
		"fatal",
		"error",
		"warn",
		"info",
		"debug",
		"trace"
	];
}));
//#endregion
//#region src/logging/state.ts
var loggingState;
var init_state = __esmMin((() => {
	loggingState = {
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
}));
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
var init_env_log_level = __esmMin((() => {
	init_levels();
	init_state();
}));
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
var init_node_require = __esmMin((() => {}));
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
var init_timestamps = __esmMin((() => {}));
//#endregion
//#region src/logging/logger.ts
function canUseNodeFs() {
	const getBuiltinModule = process.getBuiltinModule;
	if (typeof getBuiltinModule !== "function") return false;
	try {
		return getBuiltinModule("fs") !== void 0;
	} catch {
		return false;
	}
}
function resolveDefaultLogDir() {
	return canUseNodeFs() ? resolvePreferredOpenClawTmpDir() : POSIX_OPENCLAW_TMP_DIR;
}
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
	if (!canUseNodeFs()) return {
		level: "silent",
		file: DEFAULT_LOG_FILE,
		maxFileBytes: DEFAULT_MAX_LOG_FILE_BYTES
	};
	const envLevel = resolveEnvLogLevelOverride();
	if (canUseSilentVitestFileLogFastPath(envLevel)) return {
		level: "silent",
		file: defaultRollingPathForToday(),
		maxFileBytes: DEFAULT_MAX_LOG_FILE_BYTES
	};
	let cfg = loggingState.overrideSettings ?? readLoggingConfig();
	if (!cfg && !shouldSkipLoadConfigFallback()) try {
		cfg = (requireConfig?.("../config/config.js"))?.loadConfig?.().logging;
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
function registerLogTransport(transport) {
	externalTransports.add(transport);
	const logger = loggingState.cachedLogger;
	if (logger) attachExternalTransport(logger, transport);
	return () => {
		externalTransports.delete(transport);
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
var DEFAULT_LOG_DIR, DEFAULT_LOG_FILE, LOG_PREFIX, LOG_SUFFIX, MAX_LOG_AGE_MS, DEFAULT_MAX_LOG_FILE_BYTES, requireConfig, externalTransports;
var init_logger = __esmMin((() => {
	init_argv();
	init_tmp_openclaw_dir();
	init_config();
	init_env_log_level();
	init_levels();
	init_node_require();
	init_state();
	init_timestamps();
	DEFAULT_LOG_DIR = resolveDefaultLogDir();
	DEFAULT_LOG_FILE = path.join(DEFAULT_LOG_DIR, "openclaw.log");
	LOG_PREFIX = "openclaw";
	LOG_SUFFIX = ".log";
	MAX_LOG_AGE_MS = 1440 * 60 * 1e3;
	DEFAULT_MAX_LOG_FILE_BYTES = 500 * 1024 * 1024;
	requireConfig = resolveNodeRequireFromMeta(import.meta.url);
	externalTransports = /* @__PURE__ */ new Set();
}));
//#endregion
export { normalizeLogLevel as _, registerLogTransport as a, consumeRootOptionToken as b, init_timestamps as c, init_env_log_level as d, resolveEnvLogLevelOverride as f, levelToMinLevel as g, init_levels as h, isFileLogLevelEnabled as i, init_node_require as l, loggingState as m, getLogger as n, toPinoLikeLogger as o, init_state as p, init_logger as r, formatLocalIsoWithOffset as s, getChildLogger as t, resolveNodeRequireFromMeta as u, init_config as v, init_cli_root_options as x, readLoggingConfig as y };
