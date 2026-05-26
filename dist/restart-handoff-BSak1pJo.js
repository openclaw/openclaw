import { y as resolveStateDir } from "./paths-Cw7f9XhU.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
//#region src/infra/restart-handoff.ts
const GATEWAY_SUPERVISOR_RESTART_HANDOFF_FILENAME = "gateway-supervisor-restart-handoff.json";
const GATEWAY_SUPERVISOR_RESTART_HANDOFF_KIND = "gateway-supervisor-restart-handoff";
const GATEWAY_RESTART_HANDOFF_TTL_MS = 6e4;
const GATEWAY_RESTART_TRACE_HANDOFF_MAX_DURATION_MS = 10 * 6e4;
const GATEWAY_RESTART_HANDOFF_MAX_BYTES = 4096;
const MAX_INTENT_ID_LENGTH = 120;
const MAX_PROCESS_INSTANCE_ID_LENGTH = 120;
const MAX_REASON_LENGTH = 200;
const handoffLog = createSubsystemLogger("restart-handoff");
function formatShortDuration(ms) {
	const clamped = Math.max(0, Math.floor(ms));
	if (clamped < 1e3) return `${clamped}ms`;
	const seconds = Math.floor(clamped / 1e3);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = seconds % 60;
	return remainingSeconds === 0 ? `${minutes}m` : `${minutes}m ${remainingSeconds}s`;
}
function formatDiagnosticValue(value) {
	let normalized = "";
	let previousWasSpace = true;
	for (const char of value) {
		const code = char.charCodeAt(0);
		if (code <= 31 || code === 127 || /\s/u.test(char)) {
			if (!previousWasSpace) {
				normalized += " ";
				previousWasSpace = true;
			}
			continue;
		}
		normalized += char;
		previousWasSpace = false;
	}
	return normalized.trimEnd();
}
function formatGatewayRestartHandoffDiagnostic(handoff, now = Date.now()) {
	const reason = handoff.reason ? formatDiagnosticValue(handoff.reason) : void 0;
	return `Recent restart handoff: ${[
		`${handoff.restartKind} via ${handoff.supervisorMode}`,
		`source=${handoff.source}`,
		reason ? `reason=${reason}` : void 0,
		`pid=${handoff.pid}`,
		`age=${formatShortDuration(now - handoff.createdAt)}`,
		`expiresIn=${formatShortDuration(handoff.expiresAt - now)}`
	].filter((value) => Boolean(value)).join("; ")}`;
}
function resolveGatewayRestartHandoffPath(env = process.env) {
	return path.join(resolveStateDir(env), GATEWAY_SUPERVISOR_RESTART_HANDOFF_FILENAME);
}
function unlinkRegularFileSync(filePath) {
	try {
		const stat = fs.lstatSync(filePath);
		if (!stat.isFile() || stat.nlink > 1) return false;
		fs.unlinkSync(filePath);
		return true;
	} catch {
		return false;
	}
}
function normalizePid(pid) {
	return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}
function normalizeText(value, maxLength) {
	const text = typeof value === "string" ? value.trim() : "";
	return text ? text.slice(0, maxLength) : void 0;
}
function normalizeCreatedAt(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : Date.now();
}
function normalizeTtlMs(value) {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return GATEWAY_RESTART_HANDOFF_TTL_MS;
	return Math.min(Math.floor(value), GATEWAY_RESTART_HANDOFF_TTL_MS);
}
function normalizeRestartTraceHandoff(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return;
	const record = value;
	if (typeof record.startedAt !== "number" || !Number.isFinite(record.startedAt) || typeof record.lastAt !== "number" || !Number.isFinite(record.lastAt) || record.startedAt <= 0 || record.lastAt < record.startedAt || record.lastAt - record.startedAt > GATEWAY_RESTART_TRACE_HANDOFF_MAX_DURATION_MS) return;
	return {
		startedAt: record.startedAt,
		lastAt: record.lastAt
	};
}
function normalizeSource(source, reason) {
	if (source) return source;
	if (!reason) return "unknown";
	const normalized = reason.toLowerCase();
	if (normalized === "update.run") return "gateway-update";
	if (normalized === "sigusr1") return "signal";
	if (normalized === "gateway.restart") return "operator-restart";
	if (normalized.includes("plugin")) return "plugin-change";
	if (normalized.includes("config") || normalized.includes("include")) return "config-write";
	return "unknown";
}
function isSource(value) {
	return value === "config-write" || value === "gateway-update" || value === "operator-restart" || value === "plugin-change" || value === "signal" || value === "unknown";
}
function isRestartKind(value) {
	return value === "full-process" || value === "update-process";
}
function isSupervisorMode(value) {
	return value === "launchd" || value === "systemd" || value === "schtasks" || value === "external";
}
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parseGatewayRestartHandoff(raw) {
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!isRecord(parsed)) return null;
	if (parsed.kind !== "gateway-supervisor-restart-handoff" || parsed.version !== 1 || typeof parsed.intentId !== "string" || parsed.intentId.trim().length === 0 || typeof parsed.pid !== "number" || !Number.isSafeInteger(parsed.pid) || parsed.pid <= 0 || typeof parsed.createdAt !== "number" || !Number.isFinite(parsed.createdAt) || typeof parsed.expiresAt !== "number" || !Number.isFinite(parsed.expiresAt) || parsed.expiresAt <= parsed.createdAt || parsed.expiresAt - parsed.createdAt > GATEWAY_RESTART_HANDOFF_TTL_MS || !isSource(parsed.source) || !isRestartKind(parsed.restartKind) || !isSupervisorMode(parsed.supervisorMode)) return null;
	if (parsed.reason !== void 0 && typeof parsed.reason !== "string") return null;
	if (parsed.processInstanceId !== void 0 && typeof parsed.processInstanceId !== "string") return null;
	const restartTrace = normalizeRestartTraceHandoff(parsed.restartTrace);
	const processInstanceId = normalizeText(parsed.processInstanceId, MAX_PROCESS_INSTANCE_ID_LENGTH);
	const reason = normalizeText(parsed.reason, MAX_REASON_LENGTH);
	return {
		kind: GATEWAY_SUPERVISOR_RESTART_HANDOFF_KIND,
		version: 1,
		intentId: parsed.intentId.trim().slice(0, MAX_INTENT_ID_LENGTH),
		pid: parsed.pid,
		...processInstanceId ? { processInstanceId } : {},
		createdAt: Math.floor(parsed.createdAt),
		expiresAt: Math.floor(parsed.expiresAt),
		...reason ? { reason } : {},
		source: parsed.source,
		restartKind: parsed.restartKind,
		supervisorMode: parsed.supervisorMode,
		...restartTrace ? { restartTrace } : {}
	};
}
function readGatewayRestartHandoffRawSync(env) {
	const handoffPath = resolveGatewayRestartHandoffPath(env);
	try {
		const stat = fs.lstatSync(handoffPath);
		if (!stat.isFile() || stat.nlink > 1 || stat.size > GATEWAY_RESTART_HANDOFF_MAX_BYTES) return null;
		return fs.readFileSync(handoffPath, "utf8");
	} catch {
		return null;
	}
}
function writeGatewayRestartHandoffSync(opts) {
	const pid = normalizePid(opts.pid ?? process.pid);
	if (pid === null || !isRestartKind(opts.restartKind)) return null;
	if (opts.source !== void 0 && !isSource(opts.source)) return null;
	const supervisorMode = opts.supervisorMode ?? "external";
	if (!isSupervisorMode(supervisorMode)) return null;
	const env = opts.env ?? process.env;
	const createdAt = normalizeCreatedAt(opts.createdAt);
	const ttlMs = normalizeTtlMs(opts.ttlMs);
	const reason = normalizeText(opts.reason, MAX_REASON_LENGTH);
	const processInstanceId = normalizeText(opts.processInstanceId, MAX_PROCESS_INSTANCE_ID_LENGTH);
	const restartTrace = normalizeRestartTraceHandoff(opts.restartTrace);
	const payload = {
		kind: GATEWAY_SUPERVISOR_RESTART_HANDOFF_KIND,
		version: 1,
		intentId: randomUUID(),
		pid,
		...processInstanceId ? { processInstanceId } : {},
		createdAt,
		expiresAt: createdAt + ttlMs,
		...reason ? { reason } : {},
		source: normalizeSource(opts.source, reason),
		restartKind: opts.restartKind,
		supervisorMode,
		...restartTrace ? { restartTrace } : {}
	};
	let tmpPath;
	try {
		const handoffPath = resolveGatewayRestartHandoffPath(env);
		fs.mkdirSync(path.dirname(handoffPath), { recursive: true });
		tmpPath = path.join(path.dirname(handoffPath), `.${path.basename(handoffPath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
		let fd;
		try {
			fd = fs.openSync(tmpPath, "wx", 384);
			fs.writeFileSync(fd, `${JSON.stringify(payload)}\n`, "utf8");
		} finally {
			if (fd !== void 0) fs.closeSync(fd);
		}
		fs.renameSync(tmpPath, handoffPath);
		return payload;
	} catch (err) {
		if (tmpPath) unlinkRegularFileSync(tmpPath);
		handoffLog.warn(`failed to write gateway restart handoff: ${String(err)}`);
		return null;
	}
}
function readGatewayRestartHandoffSync(env = process.env, now = Date.now()) {
	const raw = readGatewayRestartHandoffRawSync(env);
	if (!raw) return null;
	const payload = parseGatewayRestartHandoff(raw);
	if (!payload || now < payload.createdAt || now > payload.expiresAt) return null;
	return payload;
}
//#endregion
export { readGatewayRestartHandoffSync as n, writeGatewayRestartHandoffSync as r, formatGatewayRestartHandoffDiagnostic as t };
