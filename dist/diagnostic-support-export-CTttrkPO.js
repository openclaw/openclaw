import { r as resolveHomeRelativePath } from "./home-dir-BOPFpGo8.js";
import { s as resolveConfigPath, y as resolveStateDir } from "./paths-Cw7f9XhU.js";
import { n as VERSION } from "./version-CQfgAE7_.js";
import { t as isBlockedObjectKey } from "./prototype-keys-gIgii6VQ.js";
import { o as parseConfigJson5 } from "./io-DoswVvYe.js";
import { c as readLatestDiagnosticStabilityBundleSync, s as readDiagnosticStabilityBundleFileSync } from "./diagnostic-stability-bundle-fLJOD4qU.js";
import { n as redactConfigObject } from "./redact-snapshot-DLK0iGBB.js";
import { a as sanitizeSupportSnapshotValue, i as sanitizeSupportConfigValue, n as redactSupportString, r as redactTextForSupport, t as redactPathForSupport } from "./diagnostic-support-redaction-GWib8H_y.js";
import { i as textSupportBundleFile, n as jsonlSupportBundleFile, o as writeSupportBundleZip, r as supportBundleContents, t as jsonSupportBundleFile } from "./diagnostic-support-bundle-IFXyP28r.js";
import { t as readConfiguredLogTail } from "./log-tail-A9kBoCdj.js";
import process from "node:process";
import fs from "node:fs";
import path from "node:path";
//#region src/logging/diagnostic-support-log-redaction.ts
const LOG_STRING_FIELD_RE = /^(?:action|channel|code|component|endpoint|event|handshake|kind|level|localAddr|logger|method|model|module|msg|name|outcome|phase|pluginId|provider|reason|remoteAddr|requestId|runId|service|source|status|subsystem|surface|target|time|traceId|type)$/iu;
const LOG_SCALAR_FIELD_RE = /^(?:active|attempt|bytes|count|durationMs|enabled|exitCode|intervalMs|jobs|limitBytes|localPort|nextWakeAtMs|pid|port|queueDepth|queued|remotePort|statusCode|waitMs|waiting)$/iu;
const OMITTED_LOG_FIELD_RE = /(?:authorization|body|chat|content|cookie|credential|detail|error|header|instruction|message|password|payload|prompt|result|secret|session[-_]?id|session[-_]?key|text|token|tool|transcript|url)/iu;
const UNSAFE_LOG_MESSAGE_RE = /(?:\b(?:ai response|assistant said|chat text|message contents|prompt|raw webhook body|tool output|tool result|transcript|user said|webhook body)\b|auto-responding\b.*:\s*["']|partial for\b.*:)/iu;
const MAX_LOG_STRING_LENGTH = 240;
const LOGTAPE_META_FIELD = "_meta";
const LOGTAPE_ARG_FIELD_RE = /^\d+$/u;
const LOGTAPE_META_STRING_FIELDS = new Map([["logLevelName", "level"], ["name", "logger"]]);
function byteLength(content) {
	return Buffer.byteLength(content, "utf8");
}
function asRecord$1(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	return value;
}
function createLogRecord() {
	return Object.create(null);
}
function sanitizeSupportLogRecord(line, redaction) {
	let parsed;
	try {
		parsed = JSON.parse(line);
	} catch {
		return {
			omitted: "unparsed",
			bytes: byteLength(line)
		};
	}
	const source = asRecord$1(parsed);
	if (!source) return {
		omitted: "non-object",
		bytes: byteLength(line)
	};
	const sanitized = createLogRecord();
	addNamedLogFields(sanitized, source, redaction);
	addLogTapeMetaFields(sanitized, source, redaction);
	addLogTapeArgFields(sanitized, source, redaction);
	return Object.keys(sanitized).length > 0 ? sanitized : {
		omitted: "no-safe-fields",
		bytes: byteLength(line)
	};
}
function addNamedLogFields(sanitized, source, redaction) {
	for (const [key, value] of Object.entries(source)) {
		if (key === LOGTAPE_META_FIELD || LOGTAPE_ARG_FIELD_RE.test(key)) continue;
		addSafeLogField(sanitized, key, value, redaction);
	}
}
function addLogTapeMetaFields(sanitized, source, redaction) {
	const meta = asRecord$1(source[LOGTAPE_META_FIELD]);
	if (!meta) return;
	for (const [sourceKey, outputKey] of LOGTAPE_META_STRING_FIELDS) {
		if (sanitized[outputKey] !== void 0) continue;
		const value = meta[sourceKey];
		if (typeof value === "string") {
			if (sourceKey === "name") {
				const record = parseJsonRecord(value);
				if (record) {
					addLogObjectFields(sanitized, record, redaction);
					continue;
				}
			}
			sanitized[outputKey] = sanitizeLogString(value, redaction);
		}
	}
}
function addLogTapeArgFields(sanitized, source, redaction) {
	const args = Object.entries(source).filter(([key]) => LOGTAPE_ARG_FIELD_RE.test(key)).toSorted(([left], [right]) => Number(left) - Number(right));
	for (const [, value] of args) {
		const record = typeof value === "string" ? parseJsonRecord(value) : asRecord$1(value);
		if (record) {
			addLogObjectFields(sanitized, record, redaction);
			continue;
		}
		if (typeof value === "string") addLogTapeMessageField(sanitized, value, redaction);
	}
}
function addLogTapeMessageField(sanitized, value, redaction) {
	const message = sanitizeLogString(value, redaction);
	if (sanitized.msg === void 0 && message && !UNSAFE_LOG_MESSAGE_RE.test(message)) {
		sanitized.msg = message;
		return;
	}
	addOmittedLogMessageMetadata(sanitized, value);
}
function addOmittedLogMessageMetadata(sanitized, value) {
	sanitized.omitted = "log-message";
	sanitized.omittedLogMessageBytes = numericLogMetadata(sanitized.omittedLogMessageBytes) + byteLength(value);
	sanitized.omittedLogMessageCount = numericLogMetadata(sanitized.omittedLogMessageCount) + 1;
}
function numericLogMetadata(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
function parseJsonRecord(value) {
	const trimmed = value.trim();
	if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return;
	try {
		return asRecord$1(JSON.parse(trimmed));
	} catch {
		return;
	}
}
function addLogObjectFields(sanitized, source, redaction) {
	for (const [key, value] of Object.entries(source)) addSafeLogField(sanitized, key, value, redaction);
}
function addSafeLogField(sanitized, key, value, redaction) {
	if (OMITTED_LOG_FIELD_RE.test(key)) return;
	if (isBlockedObjectKey(key)) return;
	if (!isSafeLogField(key, value)) return;
	if (typeof value === "string") {
		const message = sanitizeLogString(value, redaction);
		if (key === "msg" && (!message || UNSAFE_LOG_MESSAGE_RE.test(message))) {
			addOmittedLogMessageMetadata(sanitized, value);
			return;
		}
		sanitized[key] = message;
	} else if (typeof value === "number" || typeof value === "boolean" || value === null) sanitized[key] = value;
}
function sanitizeLogString(value, redaction) {
	return redactSupportString(value, redaction, {
		maxLength: MAX_LOG_STRING_LENGTH,
		truncationSuffix: ""
	});
}
function isSafeLogField(key, value) {
	if (typeof value === "string") return LOG_STRING_FIELD_RE.test(key);
	return LOG_STRING_FIELD_RE.test(key) || LOG_SCALAR_FIELD_RE.test(key);
}
//#endregion
//#region src/logging/diagnostic-support-export.ts
const DIAGNOSTIC_SUPPORT_EXPORT_VERSION = 1;
const DEFAULT_LOG_LIMIT = 5e3;
const DEFAULT_LOG_MAX_BYTES = 1e6;
const SUPPORT_EXPORT_PREFIX = "openclaw-diagnostics-";
const SUPPORT_EXPORT_SUFFIX = ".zip";
function formatExportTimestamp(now) {
	return now.toISOString().replace(/[:.]/g, "-");
}
function normalizePositiveInteger(value, fallback) {
	const parsed = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(parsed) || parsed < 1) return fallback;
	return Math.floor(parsed);
}
function asRecord(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	return value;
}
function safeScalar(value) {
	if (typeof value === "boolean") return value;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") return redactTextForSupport(value) === value && /^[A-Za-z0-9_.:-]{1,120}$/u.test(value) ? value : "<redacted>";
}
function sortedObjectKeys(value) {
	return Object.keys(asRecord(value) ?? {}).toSorted((a, b) => a.localeCompare(b));
}
function sanitizeConfigShape(parsed, configPath, stat) {
	const root = asRecord(parsed) ?? {};
	const gateway = asRecord(root.gateway);
	const auth = asRecord(gateway?.auth);
	const channels = asRecord(root.channels);
	const plugins = asRecord(root.plugins);
	const agents = Array.isArray(root.agents) ? root.agents : void 0;
	const shape = {
		path: configPath,
		exists: true,
		parseOk: true,
		bytes: stat.size,
		mtime: stat.mtime.toISOString(),
		topLevelKeys: sortedObjectKeys(root)
	};
	if (gateway) shape.gateway = {
		mode: safeScalar(gateway.mode),
		bind: safeScalar(gateway.bind),
		port: safeScalar(gateway.port),
		authMode: safeScalar(auth?.mode),
		tailscale: safeScalar(gateway.tailscale)
	};
	if (channels) shape.channels = {
		count: Object.keys(channels).length,
		ids: sortedObjectKeys(channels)
	};
	if (plugins) shape.plugins = {
		count: Object.keys(plugins).length,
		ids: sortedObjectKeys(plugins)
	};
	if (agents) shape.agents = { count: agents.length };
	return shape;
}
function sanitizeConfigDetails(parsed, redaction) {
	return sanitizeSupportConfigValue(redactConfigObject(parsed), redaction);
}
function configShapeReadFailure(params) {
	const shape = {
		path: params.configPath,
		exists: Boolean(params.stat),
		parseOk: false,
		topLevelKeys: []
	};
	if (params.stat) {
		shape.bytes = params.stat.size;
		shape.mtime = params.stat.mtime.toISOString();
	}
	if (params.error) shape.error = redactSupportString(params.error, params.redaction);
	return shape;
}
function isMissingPathError(error) {
	if (!error || typeof error !== "object" || !("code" in error)) return false;
	return error.code === "ENOENT" || error.code === "ENOTDIR";
}
function configReadErrorMessage(error, stat) {
	if (!stat && isMissingPathError(error)) return;
	return error instanceof Error ? error.message : String(error);
}
function readConfigExport(options) {
	const redactedConfigPath = redactPathForSupport(options.configPath, options);
	let stat;
	try {
		stat = fs.statSync(options.configPath);
		const parsed = parseConfigJson5(fs.readFileSync(options.configPath, "utf8"));
		if (!parsed.ok) return { shape: configShapeReadFailure({
			configPath: redactedConfigPath,
			redaction: options,
			stat,
			error: parsed.error
		}) };
		return {
			shape: sanitizeConfigShape(parsed.parsed, redactedConfigPath, stat),
			sanitized: sanitizeConfigDetails(parsed.parsed, options)
		};
	} catch (error) {
		return { shape: configShapeReadFailure({
			configPath: redactedConfigPath,
			redaction: options,
			stat,
			error: configReadErrorMessage(error, stat)
		}) };
	}
}
function redactErrorForSupport(error, redaction) {
	return redactSupportString(error instanceof Error ? error.message : String(error), redaction);
}
async function collectSupportSnapshot(params) {
	if (!params.reader) return { summary: { status: "skipped" } };
	try {
		const data = await params.reader();
		return {
			summary: {
				status: "included",
				path: params.path
			},
			file: jsonSupportBundleFile(params.path, {
				status: "ok",
				capturedAt: params.generatedAt,
				data: sanitizeSupportSnapshotValue(data, params.redaction)
			})
		};
	} catch (error) {
		const redactedError = redactErrorForSupport(error, params.redaction);
		return {
			summary: {
				status: "failed",
				path: params.path,
				error: redactedError
			},
			file: jsonSupportBundleFile(params.path, {
				status: "failed",
				capturedAt: params.generatedAt,
				error: redactedError
			})
		};
	}
}
function readStabilityBundle(target, stateDir) {
	if (target === false) return {
		status: "missing",
		dir: "$OPENCLAW_STATE_DIR/logs/stability"
	};
	if (target === void 0 || target === "latest") return readLatestDiagnosticStabilityBundleSync({ stateDir });
	return readDiagnosticStabilityBundleFileSync(target);
}
function sanitizeLogTail(tail, options) {
	return {
		status: "included",
		file: redactPathForSupport(tail.file, options),
		cursor: tail.cursor,
		size: tail.size,
		lineCount: tail.lines.length,
		truncated: tail.truncated,
		reset: tail.reset,
		lines: tail.lines.map((line) => sanitizeSupportLogRecord(line, options))
	};
}
function failedLogTail(error, redaction) {
	const redactedError = redactErrorForSupport(error, redaction);
	return {
		status: "failed",
		file: "unavailable",
		cursor: 0,
		size: 0,
		lineCount: 0,
		truncated: false,
		reset: false,
		error: redactedError,
		lines: [{
			omitted: "log-tail-read-failed",
			error: redactedError
		}]
	};
}
async function collectSupportLogTail(params) {
	try {
		return sanitizeLogTail(await params.readLogTail({
			limit: params.limit,
			maxBytes: params.maxBytes
		}), params.redaction);
	} catch (error) {
		return failedLogTail(error, params.redaction);
	}
}
function describeStabilityForDiagnostics(stability, redaction) {
	if (stability.status === "found") return {
		status: "found",
		path: redactPathForSupport(stability.path, redaction),
		mtimeMs: stability.mtimeMs,
		eventCount: stability.bundle.snapshot.count,
		reason: stability.bundle.reason,
		generatedAt: stability.bundle.generatedAt
	};
	if (stability.status === "missing") return {
		status: "missing",
		dir: redactPathForSupport(stability.dir, redaction)
	};
	return {
		status: "failed",
		path: stability.path ? redactPathForSupport(stability.path, redaction) : void 0,
		error: redactErrorForSupport(stability.error, redaction)
	};
}
function renderSummary(params) {
	const stabilityLine = params.stability.status === "found" ? `included latest stability bundle (${params.stability.bundle.snapshot.count} event(s))` : `no stability bundle included (${params.stability.status})`;
	const configLine = params.config.exists ? `config shape included (${params.config.parseOk ? "parsed" : "parse failed"})` : "config file not found";
	const logTailLine = params.logTail.status === "failed" ? `sanitized log tail unavailable (${params.logTail.error})` : `sanitized log tail (${params.logTail.lineCount} line(s), inspected ${params.logTail.size} byte(s), raw messages omitted)`;
	const supportSnapshotLine = (label, snapshot) => {
		if (snapshot.status === "included") return `${label} snapshot included (${snapshot.path})`;
		if (snapshot.status === "failed") return `${label} snapshot failed (${snapshot.error})`;
		return `${label} snapshot skipped`;
	};
	return [
		"# OpenClaw Diagnostics Export",
		"",
		"Attach this zip to the bug report. It is designed for maintainers to inspect without asking for raw logs first.",
		"",
		"## Generated",
		"",
		`Generated: ${params.generatedAt}`,
		`OpenClaw: ${VERSION}`,
		"",
		"## Contents",
		"",
		`- ${stabilityLine}`,
		`- ${logTailLine}`,
		`- ${configLine}`,
		`- ${supportSnapshotLine("gateway status", params.status)}`,
		`- ${supportSnapshotLine("gateway health", params.health)}`,
		"",
		"## Maintainer Quick Read",
		"",
		"- `manifest.json`: file inventory and privacy notes",
		"- `diagnostics.json`: top-level summary of config, logs, stability, status, and health",
		"- `config/sanitized.json`: config values with credentials, private identifiers, and prompt text redacted",
		"- `status/gateway-status.json`: sanitized service/connectivity snapshot",
		"- `health/gateway-health.json`: sanitized Gateway health snapshot",
		"- `logs/openclaw-sanitized.jsonl`: sanitized log summaries and metadata",
		"- `stability/latest.json`: newest payload-free stability bundle, when available",
		"",
		"## Privacy",
		"",
		"- raw chat text, webhook bodies, tool outputs, tokens, cookies, and secrets are not included intentionally",
		"- log records keep operational summaries and safe metadata fields",
		"- status and health snapshots redact secret fields, payload-like fields, and account/message identifiers",
		"- config output keeps useful settings but redacts secrets, private identifiers, and prompt text"
	].join("\n");
}
function defaultOutputPath(options) {
	return path.join(options.stateDir, "logs", "support", `${SUPPORT_EXPORT_PREFIX}${formatExportTimestamp(options.now)}-${process.pid}${SUPPORT_EXPORT_SUFFIX}`);
}
function resolveOutputPath(options) {
	const raw = options.outputPath?.trim();
	if (!raw) return defaultOutputPath(options);
	const resolved = path.isAbsolute(raw) || raw.startsWith("~") ? resolveHomeRelativePath(raw, { env: options.env }) : path.resolve(options.cwd, raw);
	try {
		if (fs.statSync(resolved).isDirectory()) return path.join(resolved, `${SUPPORT_EXPORT_PREFIX}${formatExportTimestamp(options.now)}-${process.pid}${SUPPORT_EXPORT_SUFFIX}`);
	} catch {}
	return resolved;
}
async function buildDiagnosticSupportExport(options = {}) {
	const env = options.env ?? process.env;
	const stateDir = options.stateDir ?? resolveStateDir(env);
	const generatedAt = (options.now ?? /* @__PURE__ */ new Date()).toISOString();
	const configPath = resolveConfigPath(env, stateDir);
	const stability = readStabilityBundle(options.stabilityBundle, stateDir);
	const redaction = {
		env,
		stateDir
	};
	const logTail = await collectSupportLogTail({
		readLogTail: options.readLogTail ?? readConfiguredLogTail,
		limit: normalizePositiveInteger(options.logLimit, DEFAULT_LOG_LIMIT),
		maxBytes: normalizePositiveInteger(options.logMaxBytes, DEFAULT_LOG_MAX_BYTES),
		redaction
	});
	const config = readConfigExport({
		configPath,
		env,
		stateDir
	});
	const [statusSnapshot, healthSnapshot] = await Promise.all([collectSupportSnapshot({
		path: "status/gateway-status.json",
		reader: options.readStatusSnapshot,
		generatedAt,
		redaction
	}), collectSupportSnapshot({
		path: "health/gateway-health.json",
		reader: options.readHealthSnapshot,
		generatedAt,
		redaction
	})]);
	const files = [
		jsonSupportBundleFile("diagnostics.json", {
			generatedAt,
			openclawVersion: VERSION,
			process: {
				platform: process.platform,
				arch: process.arch,
				node: process.versions.node,
				pid: process.pid
			},
			stateDir: redactPathForSupport(stateDir, redaction),
			config: config.shape,
			logs: {
				file: logTail.file,
				cursor: logTail.cursor,
				size: logTail.size,
				lineCount: logTail.lineCount,
				truncated: logTail.truncated,
				reset: logTail.reset
			},
			stability: describeStabilityForDiagnostics(stability, redaction),
			status: statusSnapshot.summary,
			health: healthSnapshot.summary
		}),
		jsonSupportBundleFile("config/shape.json", config.shape),
		jsonSupportBundleFile("config/sanitized.json", config.sanitized ?? null),
		jsonlSupportBundleFile("logs/openclaw-sanitized.jsonl", logTail.lines.map((line) => JSON.stringify(line)))
	];
	for (const snapshot of [statusSnapshot, healthSnapshot]) if (snapshot.file) files.push(snapshot.file);
	if (stability.status === "found") files.push(jsonSupportBundleFile("stability/latest.json", stability.bundle));
	files.push(textSupportBundleFile("summary.md", renderSummary({
		generatedAt,
		stability,
		logTail,
		config: config.shape,
		status: statusSnapshot.summary,
		health: healthSnapshot.summary
	})));
	const manifest = {
		version: 1,
		generatedAt,
		openclawVersion: VERSION,
		platform: process.platform,
		arch: process.arch,
		node: process.versions.node,
		stateDir: redactPathForSupport(stateDir, redaction),
		contents: supportBundleContents(files),
		privacy: {
			payloadFree: true,
			rawLogsIncluded: false,
			notes: [
				"Stability bundles are payload-free diagnostic snapshots.",
				"Logs keep operational summaries and safe metadata fields; payload-like fields are omitted.",
				"Status and health snapshots redact secrets, payload-like fields, and account/message identifiers.",
				"Config output includes useful settings with credentials, private identifiers, and prompt text redacted."
			]
		}
	};
	return {
		manifest,
		files: [jsonSupportBundleFile("manifest.json", manifest), ...files]
	};
}
async function writeDiagnosticSupportExport(options = {}) {
	const env = options.env ?? process.env;
	const stateDir = options.stateDir ?? resolveStateDir(env);
	const now = options.now ?? /* @__PURE__ */ new Date();
	const outputPath = resolveOutputPath({
		outputPath: options.outputPath,
		cwd: options.cwd ?? process.cwd(),
		env,
		stateDir,
		now
	});
	const artifact = await buildDiagnosticSupportExport({
		...options,
		env,
		stateDir,
		now
	});
	return {
		path: outputPath,
		bytes: await writeSupportBundleZip({
			outputPath,
			files: artifact.files,
			compressionLevel: 6
		}),
		manifest: artifact.manifest
	};
}
//#endregion
export { DIAGNOSTIC_SUPPORT_EXPORT_VERSION, buildDiagnosticSupportExport, writeDiagnosticSupportExport };
