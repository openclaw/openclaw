import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { f as readLoggingConfig, p as shouldSkipMutatingLoggingConfigRead, r as redactSecrets, s as redactSensitiveText } from "./redact-ok5Q8nmw.js";
import { t as expandHomePrefix } from "./home-dir-BOPFpGo8.js";
import { n as appendRegularFileSync } from "./regular-file-DaVeNX32.js";
import { t as isBlockedObjectKey } from "./prototype-keys-gIgii6VQ.js";
import "./regular-file-CBe_wA_B.js";
import { _ as getActiveDiagnosticTraceContext, b as isValidDiagnosticTraceId, n as emitDiagnosticEvent, v as isValidDiagnosticSpanId, y as isValidDiagnosticTraceFlags } from "./diagnostic-events-BLgzARSp.js";
import { n as resolvePreferredOpenClawTmpDir, t as POSIX_OPENCLAW_TMP_DIR } from "./tmp-openclaw-dir-C60hWKdY.js";
import { t as loggingState } from "./state-CHRYWIGY.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Logger } from "tslog";
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
		trace: 1,
		debug: 2,
		info: 3,
		warn: 4,
		error: 5,
		fatal: 6,
		silent: Number.POSITIVE_INFINITY
	}[level];
}
//#endregion
//#region src/logging/env-log-level.ts
function resolveEnvLogLevelOverride() {
	const trimmed = normalizeOptionalString(process.env.OPENCLAW_LOG_LEVEL) ?? "";
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
//#region src/logging/timestamps.ts
function isValidTimeZone(tz) {
	try {
		new Intl.DateTimeFormat("en", { timeZone: tz }).format();
		return true;
	} catch {
		return false;
	}
}
function resolveEffectiveTimeZone(timeZone) {
	const explicit = timeZone ?? process.env.TZ;
	return explicit && isValidTimeZone(explicit) ? explicit : Intl.DateTimeFormat().resolvedOptions().timeZone;
}
function formatOffset(offsetRaw) {
	return offsetRaw === "GMT" ? "+00:00" : offsetRaw.slice(3);
}
function getTimestampParts(date, timeZone) {
	const fmt = new Intl.DateTimeFormat("en", {
		timeZone: resolveEffectiveTimeZone(timeZone),
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
	const parts = Object.fromEntries(fmt.formatToParts(date).map((part) => [part.type, part.value]));
	return {
		year: parts.year,
		month: parts.month,
		day: parts.day,
		hour: parts.hour,
		minute: parts.minute,
		second: parts.second,
		fractionalSecond: parts.fractionalSecond,
		offset: formatOffset(parts.timeZoneName ?? "GMT")
	};
}
function formatTimestamp(date, options) {
	const style = options?.style ?? "medium";
	const parts = getTimestampParts(date, options?.timeZone);
	switch (style) {
		case "short": return `${parts.hour}:${parts.minute}:${parts.second}${parts.offset}`;
		case "medium": return `${parts.hour}:${parts.minute}:${parts.second}.${parts.fractionalSecond}${parts.offset}`;
		case "long": return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${parts.fractionalSecond}${parts.offset}`;
	}
	throw new Error("Unsupported timestamp style");
}
/**
* @deprecated Use formatTimestamp from "./timestamps.js" instead.
* This function will be removed in a future version.
*/
function formatLocalIsoWithOffset(now, timeZone) {
	return formatTimestamp(now, {
		style: "long",
		timeZone
	});
}
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
function resolveDefaultLogFile(defaultLogDir) {
	return canUseNodeFs() ? path.join(defaultLogDir, "openclaw.log") : `${POSIX_OPENCLAW_TMP_DIR}/openclaw.log`;
}
const DEFAULT_LOG_DIR = resolveDefaultLogDir();
const DEFAULT_LOG_FILE = resolveDefaultLogFile(DEFAULT_LOG_DIR);
const LOG_PREFIX = "openclaw";
const LOG_SUFFIX = ".log";
const MAX_LOG_AGE_MS = 1440 * 60 * 1e3;
const DEFAULT_MAX_LOG_FILE_BYTES = 100 * 1024 * 1024;
const MAX_ROTATED_LOG_FILES = 5;
const MAX_DIAGNOSTIC_LOG_BINDINGS_JSON_CHARS = 8 * 1024;
const MAX_DIAGNOSTIC_LOG_MESSAGE_CHARS = 4 * 1024;
const loadLoggerConfigDefault = () => readLoggingConfig();
let loadLoggerConfig = loadLoggerConfigDefault;
function setLoggerConfigLoaderForTests(loader) {
	loadLoggerConfig = loader ?? loadLoggerConfigDefault;
	loggingState.cachedLogger = null;
	loggingState.cachedSettings = null;
}
const MAX_DIAGNOSTIC_LOG_ATTRIBUTE_COUNT = 32;
const MAX_DIAGNOSTIC_LOG_ATTRIBUTE_VALUE_CHARS = 2 * 1024;
const MAX_DIAGNOSTIC_LOG_NAME_CHARS = 120;
const MAX_FILE_LOG_MESSAGE_CHARS = 4 * 1024;
const MAX_FILE_LOG_CONTEXT_VALUE_CHARS = 512;
const DIAGNOSTIC_LOG_ATTRIBUTE_KEY_RE = /^[A-Za-z0-9_.:-]{1,64}$/u;
const HOSTNAME = os.hostname() || "unknown";
function clampDiagnosticLogText(value, maxChars) {
	return value.length > maxChars ? `${value.slice(0, maxChars)}...(truncated)` : value;
}
function sanitizeDiagnosticLogText(value, maxChars) {
	return clampDiagnosticLogText(redactSensitiveText(clampDiagnosticLogText(value, maxChars)), maxChars);
}
function normalizeDiagnosticLogName(value) {
	if (!value || value.trim().startsWith("{")) return;
	const sanitized = sanitizeDiagnosticLogText(value.trim(), MAX_DIAGNOSTIC_LOG_NAME_CHARS);
	return DIAGNOSTIC_LOG_ATTRIBUTE_KEY_RE.test(sanitized) ? sanitized : void 0;
}
function assignDiagnosticLogAttribute(attributes, state, key, value) {
	if (state.count >= MAX_DIAGNOSTIC_LOG_ATTRIBUTE_COUNT) return;
	const normalizedKey = key.trim();
	if (isBlockedObjectKey(normalizedKey)) return;
	if (redactSensitiveText(normalizedKey) !== normalizedKey) return;
	if (!DIAGNOSTIC_LOG_ATTRIBUTE_KEY_RE.test(normalizedKey)) return;
	if (typeof value === "string") {
		attributes[normalizedKey] = sanitizeDiagnosticLogText(value, MAX_DIAGNOSTIC_LOG_ATTRIBUTE_VALUE_CHARS);
		state.count += 1;
		return;
	}
	if (typeof value === "number" && Number.isFinite(value)) {
		attributes[normalizedKey] = value;
		state.count += 1;
		return;
	}
	if (typeof value === "boolean") {
		attributes[normalizedKey] = value;
		state.count += 1;
	}
}
function addDiagnosticLogAttributesFrom(attributes, state, source) {
	if (!source) return;
	for (const key in source) {
		if (state.count >= MAX_DIAGNOSTIC_LOG_ATTRIBUTE_COUNT) break;
		if (!Object.hasOwn(source, key) || key === "trace") continue;
		assignDiagnosticLogAttribute(attributes, state, key, source[key]);
	}
}
function isPlainLogRecordObject(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}
function normalizeTraceContext(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	const candidate = value;
	if (!isValidDiagnosticTraceId(candidate.traceId)) return;
	if (candidate.spanId !== void 0 && !isValidDiagnosticSpanId(candidate.spanId)) return;
	if (candidate.parentSpanId !== void 0 && !isValidDiagnosticSpanId(candidate.parentSpanId)) return;
	if (candidate.traceFlags !== void 0 && !isValidDiagnosticTraceFlags(candidate.traceFlags)) return;
	return {
		traceId: candidate.traceId,
		...candidate.spanId ? { spanId: candidate.spanId } : {},
		...candidate.parentSpanId ? { parentSpanId: candidate.parentSpanId } : {},
		...candidate.traceFlags ? { traceFlags: candidate.traceFlags } : {}
	};
}
function extractTraceContext(value) {
	const direct = normalizeTraceContext(value);
	if (direct) return direct;
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	return normalizeTraceContext(value.trace);
}
function getSortedNumericLogArgs(logObj) {
	return Object.entries(logObj).filter(([key]) => /^\d+$/.test(key)).toSorted((a, b) => Number(a[0]) - Number(b[0])).map(([, value]) => value);
}
function clampFileLogText(value, maxChars) {
	return value.length > maxChars ? `${value.slice(0, maxChars)}...(truncated)` : value;
}
function normalizeFileLogContextValue(value) {
	if (typeof value === "string") {
		const normalized = value.trim();
		return normalized ? clampFileLogText(normalized, MAX_FILE_LOG_CONTEXT_VALUE_CHARS) : void 0;
	}
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	if (typeof value === "boolean") return String(value);
}
function readFirstContextString(sources, keys) {
	for (const source of sources) {
		if (!source) continue;
		for (const key of keys) {
			const value = normalizeFileLogContextValue(source[key]);
			if (value) return value;
		}
	}
}
function stringifyFileLogMessagePart(value) {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
	if (value instanceof Error) return value.message || value.name;
	if (isPlainLogRecordObject(value) && typeof value.message === "string") return value.message;
	if (value === null || value === void 0) return;
	try {
		return JSON.stringify(value);
	} catch {
		return;
	}
}
function buildFileLogMessage(numericArgs) {
	const parts = numericArgs.map(stringifyFileLogMessagePart).filter((part) => Boolean(part && part.trim()));
	if (parts.length === 0) return;
	return clampFileLogText(parts.join(" "), MAX_FILE_LOG_MESSAGE_CHARS);
}
function extractLogBindingPrefix(numericArgs) {
	if (typeof numericArgs[0] === "string" && numericArgs[0].length <= MAX_DIAGNOSTIC_LOG_BINDINGS_JSON_CHARS && numericArgs[0].trim().startsWith("{")) try {
		const parsed = JSON.parse(numericArgs[0]);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return {
			bindings: parsed,
			args: numericArgs.slice(1)
		};
	} catch {}
	return { args: numericArgs };
}
function findLogTraceContext(bindings, numericArgs) {
	const fromBindings = extractTraceContext(bindings);
	if (fromBindings) return fromBindings;
	for (const arg of numericArgs) {
		const fromArg = extractTraceContext(arg);
		if (fromArg) return fromArg;
	}
}
function buildTraceFileLogFields(logObj) {
	const { bindings, args } = extractLogBindingPrefix(getSortedNumericLogArgs(logObj));
	const trace = findLogTraceContext(bindings, args) ?? getActiveDiagnosticTraceContext();
	if (!trace) return;
	return {
		traceId: trace.traceId,
		...trace.spanId ? { spanId: trace.spanId } : {},
		...trace.parentSpanId ? { parentSpanId: trace.parentSpanId } : {},
		...trace.traceFlags ? { traceFlags: trace.traceFlags } : {}
	};
}
function buildStructuredFileLogFields(logObj) {
	const { bindings, args } = extractLogBindingPrefix(getSortedNumericLogArgs(logObj));
	const structuredArg = isPlainLogRecordObject(args[0]) ? args[0] : void 0;
	const sources = [
		structuredArg,
		bindings,
		logObj
	];
	const message = buildFileLogMessage(structuredArg && typeof structuredArg.message !== "string" ? args.slice(1) : args);
	const agentId = readFirstContextString(sources, ["agent_id", "agentId"]);
	const sessionId = readFirstContextString(sources, [
		"session_id",
		"sessionId",
		"sessionKey"
	]);
	const channel = readFirstContextString(sources, ["channel", "messageProvider"]);
	return {
		hostname: HOSTNAME,
		...message ? { message } : {},
		...agentId ? { agent_id: agentId } : {},
		...sessionId ? { session_id: sessionId } : {},
		...channel ? { channel } : {}
	};
}
function buildDiagnosticLogRecord(logObj) {
	const meta = logObj["_meta"];
	const { bindings, args: numericArgs } = extractLogBindingPrefix(getSortedNumericLogArgs(logObj));
	const trace = findLogTraceContext(bindings, numericArgs) ?? getActiveDiagnosticTraceContext();
	const structuredArg = numericArgs[0];
	const structuredBindings = isPlainLogRecordObject(structuredArg) ? structuredArg : void 0;
	if (structuredBindings) numericArgs.shift();
	let message = "";
	if (numericArgs.length > 0 && typeof numericArgs[numericArgs.length - 1] === "string") message = sanitizeDiagnosticLogText(String(numericArgs.pop()), MAX_DIAGNOSTIC_LOG_MESSAGE_CHARS);
	else if (numericArgs.length === 1 && (typeof numericArgs[0] === "number" || typeof numericArgs[0] === "boolean")) {
		message = String(numericArgs[0]);
		numericArgs.length = 0;
	}
	if (!message) message = "log";
	const attributes = Object.create(null);
	const attributeState = { count: 0 };
	addDiagnosticLogAttributesFrom(attributes, attributeState, bindings);
	addDiagnosticLogAttributesFrom(attributes, attributeState, structuredBindings);
	const code = {};
	if (meta?.path?.fileLine) {
		const line = Number(meta.path.fileLine);
		if (Number.isFinite(line)) code.line = line;
	}
	if (meta?.path?.method) code.functionName = sanitizeDiagnosticLogText(meta.path.method, MAX_DIAGNOSTIC_LOG_NAME_CHARS);
	const loggerName = normalizeDiagnosticLogName(meta?.name);
	const loggerParents = meta?.parentNames?.map(normalizeDiagnosticLogName).filter((name) => Boolean(name));
	return {
		type: "log.record",
		level: meta?.logLevelName ?? "INFO",
		message,
		...loggerName ? { loggerName } : {},
		...loggerParents?.length ? { loggerParents } : {},
		...Object.keys(attributes).length > 0 ? { attributes } : {},
		...Object.keys(code).length > 0 ? { code } : {},
		...trace ? { trace } : {}
	};
}
function isLogRedactionDisabled() {
	return readLoggingConfig()?.redactSensitive === "off";
}
function redactLogRecordForTransport(record) {
	return isLogRedactionDisabled() ? record : redactSecrets(record);
}
function attachDiagnosticEventTransport(logger) {
	logger.attachTransport((logObj) => {
		try {
			emitDiagnosticEvent(buildDiagnosticLogRecord(redactLogRecordForTransport(logObj)));
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
	const cfg = loggingState.overrideSettings ?? loadLoggerConfig();
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
	if (level === "silent") return false;
	if (settings.level === "silent") return false;
	return levelToMinLevel(level) >= levelToMinLevel(settings.level);
}
function buildLogger(settings) {
	const logger = new Logger({
		name: "openclaw",
		maskValuesOfKeys: [],
		minLevel: levelToMinLevel(settings.level),
		type: "hidden"
	});
	if (settings.level === "silent") {
		attachDiagnosticEventTransport(logger);
		return logger;
	}
	const rollingFile = isRollingPath(settings.file);
	let activeFile = resolveActiveLogFile(settings.file);
	fs.mkdirSync(path.dirname(activeFile), { recursive: true });
	if (rollingFile) pruneOldRollingLogs(path.dirname(activeFile));
	let currentFileBytes = getCurrentLogFileBytes(activeFile);
	let warnedAboutRotationFailure = false;
	logger.attachTransport((logObj) => {
		try {
			const nextActiveFile = resolveActiveLogFile(settings.file);
			if (nextActiveFile !== activeFile) {
				activeFile = nextActiveFile;
				fs.mkdirSync(path.dirname(activeFile), { recursive: true });
				if (rollingFile) pruneOldRollingLogs(path.dirname(activeFile));
				currentFileBytes = getCurrentLogFileBytes(activeFile);
			}
			const time = formatTimestamp(logObj.date ?? /* @__PURE__ */ new Date(), { style: "long" });
			const traceFields = buildTraceFileLogFields(logObj);
			const structuredFields = buildStructuredFileLogFields(logObj);
			const record = {
				...logObj,
				time,
				...structuredFields,
				...traceFields
			};
			const payload = `${redactSensitiveText(JSON.stringify(redactLogRecordForTransport(record)))}\n`;
			const payloadBytes = Buffer.byteLength(payload, "utf8");
			const nextBytes = currentFileBytes + payloadBytes;
			if (currentFileBytes > 0 && nextBytes > settings.maxFileBytes) {
				if (rotateLogFile(activeFile)) {
					currentFileBytes = getCurrentLogFileBytes(activeFile);
					warnedAboutRotationFailure = false;
				} else if (!warnedAboutRotationFailure) {
					warnedAboutRotationFailure = true;
					process.stderr.write(`[openclaw] log file rotation failed; continuing writes file=${activeFile} maxFileBytes=${settings.maxFileBytes}\n`);
				}
			}
			if (appendLogLine(activeFile, payload)) currentFileBytes += payloadBytes;
		} catch {}
	});
	attachDiagnosticEventTransport(logger);
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
		appendRegularFileSync({
			filePath: file,
			content: line
		});
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
	const minLevel = opts?.level ? levelToMinLevel(opts.level) : base.settings.minLevel;
	const name = bindings ? JSON.stringify(bindings) : void 0;
	return base.getSubLogger({
		name,
		minLevel,
		prefix: bindings ? [name ?? ""] : []
	});
}
function toPinoLikeLogger(logger, level) {
	const buildChild = (bindings) => toPinoLikeLogger(logger.getSubLogger({
		name: bindings ? JSON.stringify(bindings) : void 0,
		minLevel: logger.settings.minLevel
	}), level);
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
function setLoggerOverride(settings) {
	loggingState.overrideSettings = settings;
	loggingState.cachedLogger = null;
	loggingState.cachedSettings = null;
	loggingState.cachedConsoleSettings = null;
}
function resetLogger() {
	loggingState.cachedLogger = null;
	loggingState.cachedSettings = null;
	loggingState.cachedConsoleSettings = null;
	loggingState.overrideSettings = null;
	loadLoggerConfig = loadLoggerConfigDefault;
}
const testApi = {
	resolveActiveLogFile,
	shouldSkipMutatingLoggingConfigRead
};
function formatLocalDate(date) {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function defaultRollingPathForToday() {
	return rollingPathForDate(DEFAULT_LOG_DIR, /* @__PURE__ */ new Date());
}
function rollingPathForDate(dir, date) {
	const today = formatLocalDate(date);
	return path.join(dir, `${LOG_PREFIX}-${today}${LOG_SUFFIX}`);
}
function resolveActiveLogFile(file) {
	const expandedFile = expandHomePrefix(file);
	if (!isRollingPath(expandedFile)) return expandedFile;
	return rollingPathForDate(path.dirname(expandedFile), /* @__PURE__ */ new Date());
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
function rotatedLogPath(file, index) {
	const ext = path.extname(file);
	return `${file.slice(0, file.length - ext.length)}.${index}${ext}`;
}
function rotateLogFile(file) {
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.rmSync(rotatedLogPath(file, MAX_ROTATED_LOG_FILES), { force: true });
		for (let index = MAX_ROTATED_LOG_FILES - 1; index >= 1; index -= 1) {
			const from = rotatedLogPath(file, index);
			if (!fs.existsSync(from)) continue;
			fs.renameSync(from, rotatedLogPath(file, index + 1));
		}
		if (fs.existsSync(file)) fs.renameSync(file, rotatedLogPath(file, 1));
		return true;
	} catch {
		return false;
	}
}
//#endregion
export { levelToMinLevel as _, getResolvedLoggerSettings as a, setLoggerConfigLoaderForTests as c, toPinoLikeLogger as d, formatLocalIsoWithOffset as f, ALLOWED_LOG_LEVELS as g, resolveEnvLogLevelOverride as h, getLogger as i, setLoggerOverride as l, isValidTimeZone as m, DEFAULT_LOG_FILE as n, isFileLogLevelEnabled as o, formatTimestamp as p, getChildLogger as r, resetLogger as s, DEFAULT_LOG_DIR as t, testApi as u, normalizeLogLevel as v, tryParseLogLevel as y };
