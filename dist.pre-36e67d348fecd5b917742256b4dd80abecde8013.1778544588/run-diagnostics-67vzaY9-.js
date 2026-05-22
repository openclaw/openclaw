import { i as redactSensitiveText } from "./redact-1fZUZMlV.js";
import { c as normalizeOptionalString } from "./string-coerce-Bje8XVt9.js";
//#region src/cron/run-diagnostics.ts
const MAX_ENTRIES = 10;
const MAX_ENTRY_CHARS = 1e3;
const MAX_SUMMARY_CHARS = 2e3;
const EXEC_DIAGNOSTIC_TAIL_CHARS = 2e3;
function normalizeSeverity(value) {
	return value === "info" || value === "warn" || value === "error" ? value : "error";
}
function normalizeSource(value) {
	switch (value) {
		case "cron-preflight":
		case "cron-setup":
		case "model-preflight":
		case "agent-run":
		case "tool":
		case "exec":
		case "delivery": return value;
		default: return "agent-run";
	}
}
function normalizeTimestamp(value, nowMs) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : nowMs();
}
function formatUnknownError(error) {
	if (error instanceof Error) return error.message || error.name;
	return String(error);
}
function isRecord(value) {
	return value !== null && typeof value === "object";
}
function normalizeToolName(value) {
	if (typeof value !== "string") return;
	return normalizeOptionalString(value);
}
function normalizeExitCode(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	return value === null ? null : void 0;
}
function tailText(value, maxChars) {
	if (value.length <= maxChars) return value;
	return value.slice(value.length - maxChars);
}
function normalizeDiagnosticMessage(value) {
	if (typeof value !== "string") return {};
	const normalized = normalizeOptionalString(value);
	if (!normalized) return {};
	const redacted = redactSensitiveText(normalized, { mode: "tools" });
	if (redacted.length <= MAX_ENTRY_CHARS) return { message: redacted };
	return {
		message: `${redacted.slice(0, MAX_ENTRY_CHARS - 1)}…`,
		truncated: true
	};
}
function trimSummary(value) {
	const normalized = normalizeOptionalString(value);
	if (!normalized) return;
	if (normalized.length <= MAX_SUMMARY_CHARS) return normalized;
	return `${normalized.slice(0, MAX_SUMMARY_CHARS - 1)}…`;
}
function summarizeCronRunDiagnostics(diagnostics) {
	if (!diagnostics) return;
	return trimSummary(diagnostics.summary ?? diagnostics.entries[0]?.message);
}
function normalizeCronRunDiagnostics(value, opts) {
	if (!value || typeof value !== "object") return;
	const record = value;
	const nowMs = opts?.nowMs ?? Date.now;
	const entriesRaw = Array.isArray(record.entries) ? record.entries : [];
	const entries = [];
	for (const item of entriesRaw) {
		if (!item || typeof item !== "object") continue;
		const entry = item;
		const normalized = normalizeDiagnosticMessage(entry.message);
		if (!normalized.message) continue;
		entries.push({
			ts: normalizeTimestamp(entry.ts, nowMs),
			source: normalizeSource(entry.source),
			severity: normalizeSeverity(entry.severity),
			message: normalized.message,
			...typeof entry.toolName === "string" && entry.toolName.trim() ? { toolName: entry.toolName.trim() } : {},
			...typeof entry.exitCode === "number" && Number.isFinite(entry.exitCode) ? { exitCode: entry.exitCode } : entry.exitCode === null ? { exitCode: null } : {},
			...entry.truncated === true || normalized.truncated ? { truncated: true } : {}
		});
		if (entries.length > MAX_ENTRIES) entries.shift();
	}
	const summary = trimSummary(typeof record.summary === "string" ? redactSensitiveText(record.summary, { mode: "tools" }) : void 0);
	if (entries.length === 0 && !summary) return;
	return {
		...summary ? { summary } : {},
		entries
	};
}
function mergeCronRunDiagnostics(...values) {
	const entries = [];
	let summaryCandidate;
	for (const value of values) {
		const normalized = normalizeCronRunDiagnostics(value);
		if (!normalized) continue;
		const entryCandidate = normalized.entries.findLast((entry) => entry.severity === "error") ?? normalized.entries.findLast((entry) => entry.severity === "warn") ?? normalized.entries.findLast((entry) => entry.severity === "info");
		const summary = trimSummary(normalized.summary ?? entryCandidate?.message);
		if (summary) {
			const severity = entryCandidate?.severity === "error" ? 2 : entryCandidate?.severity === "warn" ? 1 : 0;
			const order = entries.length + normalized.entries.length;
			if (!summaryCandidate || severity > summaryCandidate.severity || severity === summaryCandidate.severity && order >= summaryCandidate.order) summaryCandidate = {
				summary,
				severity,
				order
			};
		}
		entries.push(...normalized.entries);
	}
	return normalizeCronRunDiagnostics({
		summary: summaryCandidate?.summary,
		entries
	});
}
function createCronRunDiagnosticsFromError(source, error, opts) {
	const message = formatUnknownError(error);
	return normalizeCronRunDiagnostics({
		summary: message,
		entries: [{
			ts: opts?.nowMs?.() ?? Date.now(),
			source,
			severity: opts?.severity ?? "error",
			message,
			toolName: opts?.toolName,
			exitCode: opts?.exitCode
		}]
	}, opts);
}
function createCronRunDiagnosticsFromExecDetails(details, opts) {
	if (!isRecord(details)) return;
	const status = typeof details.status === "string" ? details.status : void 0;
	const exitCode = normalizeExitCode(details.exitCode);
	if (!(status === "failed" || typeof exitCode === "number" && exitCode !== 0)) return;
	const aggregated = normalizeOptionalString(details.aggregated);
	const message = aggregated ? tailText(aggregated, EXEC_DIAGNOSTIC_TAIL_CHARS) : typeof exitCode === "number" ? `exec failed with exit code ${exitCode}` : "exec failed";
	return normalizeCronRunDiagnostics({
		summary: message,
		entries: [{
			ts: opts?.nowMs?.() ?? Date.now(),
			source: "exec",
			severity: status === "failed" ? "error" : "warn",
			message,
			toolName: opts?.toolName,
			exitCode
		}]
	}, opts);
}
function createCronRunDiagnosticsFromToolPayload(payload, opts) {
	if (!isRecord(payload)) return;
	const toolName = normalizeToolName(payload.toolName) ?? normalizeToolName(payload.name);
	const detailsDiagnostics = createCronRunDiagnosticsFromExecDetails(payload.details, {
		nowMs: opts?.nowMs,
		toolName
	});
	const isError = payload.isError === true;
	const text = typeof payload.text === "string" ? payload.text : void 0;
	return mergeCronRunDiagnostics(detailsDiagnostics, isError && text ? createCronRunDiagnosticsFromError("tool", text, {
		severity: "error",
		nowMs: opts?.nowMs,
		toolName
	}) : void 0);
}
function createCronRunDiagnosticsFromAgentResult(result, opts) {
	const record = isRecord(result) ? result : {};
	const meta = record.meta && typeof record.meta === "object" ? record.meta : {};
	const diagnostics = [];
	const payloads = Array.isArray(record.payloads) ? record.payloads : [];
	for (const payload of payloads) diagnostics.push(createCronRunDiagnosticsFromToolPayload(payload, opts));
	const metaError = meta.error && typeof meta.error === "object" ? meta.error : void 0;
	if (typeof metaError?.message === "string") diagnostics.push(createCronRunDiagnosticsFromError("agent-run", metaError.message, opts));
	const failureSignal = meta.failureSignal && typeof meta.failureSignal === "object" ? meta.failureSignal : void 0;
	if (typeof failureSignal?.message === "string") diagnostics.push(createCronRunDiagnosticsFromError("tool", failureSignal.message, opts));
	return mergeCronRunDiagnostics(...diagnostics);
}
//#endregion
export { summarizeCronRunDiagnostics as a, normalizeCronRunDiagnostics as i, createCronRunDiagnosticsFromError as n, mergeCronRunDiagnostics as r, createCronRunDiagnosticsFromAgentResult as t };
