import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, d as normalizeStringifiedOptionalString } from "./string-coerce-DyL154ka.js";
import { i as isPathInside } from "./path-BlG8lhgR.js";
import { E as pathExists } from "./fs-safe-CV86zY9G.js";
import { o as root } from "./secure-temp-dir-aidxCRgA.js";
import { t as appendRegularFile } from "./regular-file-DaVeNX32.js";
import { t as privateFileStore } from "./private-file-store-DMtyjgoc.js";
import { r as parseByteSize } from "./zod-schema-Dsy5tXpj.js";
import { i as normalizeCronRunDiagnostics } from "./run-diagnostics-BXtBy-0s.js";
import fs from "node:fs";
import path from "node:path";
import fs$1 from "node:fs/promises";
//#region src/cron/run-log.ts
function assertSafeCronRunLogJobId(jobId) {
	const trimmed = jobId.trim();
	if (!trimmed) throw new Error("invalid cron run log job id");
	if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("\0")) throw new Error("invalid cron run log job id");
	return trimmed;
}
function resolveCronRunLogPath(params) {
	const storePath = path.resolve(params.storePath);
	const dir = path.dirname(storePath);
	const runsDir = path.resolve(dir, "runs");
	const safeJobId = assertSafeCronRunLogJobId(params.jobId);
	const resolvedPath = path.resolve(runsDir, `${safeJobId}.jsonl`);
	if (!isPathInside(runsDir, resolvedPath)) throw new Error("invalid cron run log job id");
	return resolvedPath;
}
const writesByPath = /* @__PURE__ */ new Map();
async function setSecureFileMode(filePath) {
	await fs$1.chmod(filePath, 384).catch(() => void 0);
}
const DEFAULT_CRON_RUN_LOG_MAX_BYTES = 2e6;
const DEFAULT_CRON_RUN_LOG_KEEP_LINES = 2e3;
function resolveCronRunLogPruneOptions(cfg) {
	let maxBytes = DEFAULT_CRON_RUN_LOG_MAX_BYTES;
	if (cfg?.maxBytes !== void 0) try {
		const configuredMaxBytes = normalizeStringifiedOptionalString(cfg.maxBytes);
		if (configuredMaxBytes) maxBytes = parseByteSize(configuredMaxBytes, { defaultUnit: "b" });
	} catch {
		maxBytes = DEFAULT_CRON_RUN_LOG_MAX_BYTES;
	}
	let keepLines = DEFAULT_CRON_RUN_LOG_KEEP_LINES;
	if (typeof cfg?.keepLines === "number" && Number.isFinite(cfg.keepLines) && cfg.keepLines > 0) keepLines = Math.floor(cfg.keepLines);
	return {
		maxBytes,
		keepLines
	};
}
async function drainPendingWrite(filePath) {
	const resolved = path.resolve(filePath);
	const pending = writesByPath.get(resolved);
	if (pending) await pending.catch(() => void 0);
}
async function pruneIfNeeded(filePath, opts) {
	const stat = await fs$1.stat(filePath).catch(() => null);
	if (!stat || stat.size <= opts.maxBytes) return;
	const lines = (await fs$1.readFile(filePath, "utf-8").catch(() => "")).split("\n").map((l) => l.trim()).filter(Boolean);
	const kept = lines.slice(Math.max(0, lines.length - opts.keepLines));
	await privateFileStore(path.dirname(filePath)).writeText(path.basename(filePath), `${kept.join("\n")}\n`);
}
async function appendCronRunLog(filePath, entry, opts) {
	const resolved = path.resolve(filePath);
	const next = (writesByPath.get(resolved) ?? Promise.resolve()).catch(() => void 0).then(async () => {
		const runDir = path.dirname(resolved);
		await fs$1.mkdir(runDir, {
			recursive: true,
			mode: 448
		});
		await fs$1.chmod(runDir, 448).catch(() => void 0);
		await appendRegularFile({
			filePath: resolved,
			content: `${JSON.stringify(entry)}\n`,
			rejectSymlinkParents: true
		});
		await setSecureFileMode(resolved);
		await pruneIfNeeded(resolved, {
			maxBytes: opts?.maxBytes ?? 2e6,
			keepLines: opts?.keepLines ?? 2e3
		});
	});
	writesByPath.set(resolved, next);
	try {
		await next;
	} finally {
		if (writesByPath.get(resolved) === next) writesByPath.delete(resolved);
	}
}
function readCronRunLogEntriesSync(filePath, opts) {
	const limit = Math.max(1, Math.min(5e3, Math.floor(opts?.limit ?? 200)));
	let raw;
	try {
		raw = fs.readFileSync(path.resolve(filePath), "utf-8");
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return [];
		throw error;
	}
	return parseAllRunLogEntries(raw, { jobId: opts?.jobId }).slice(-limit);
}
function normalizeRunStatusFilter(status) {
	if (status === "ok" || status === "error" || status === "skipped" || status === "all") return status;
	return "all";
}
function normalizeRunStatuses(opts) {
	if (Array.isArray(opts?.statuses) && opts.statuses.length > 0) {
		const filtered = opts.statuses.filter((status) => status === "ok" || status === "error" || status === "skipped");
		if (filtered.length > 0) return Array.from(new Set(filtered));
	}
	const status = normalizeRunStatusFilter(opts?.status);
	if (status === "all") return null;
	return [status];
}
function normalizeDeliveryStatuses(opts) {
	if (Array.isArray(opts?.deliveryStatuses) && opts.deliveryStatuses.length > 0) {
		const filtered = opts.deliveryStatuses.filter((status) => status === "delivered" || status === "not-delivered" || status === "unknown" || status === "not-requested");
		if (filtered.length > 0) return Array.from(new Set(filtered));
	}
	if (opts?.deliveryStatus === "delivered" || opts?.deliveryStatus === "not-delivered" || opts?.deliveryStatus === "unknown" || opts?.deliveryStatus === "not-requested") return [opts.deliveryStatus];
	return null;
}
function parseAllRunLogEntries(raw, opts) {
	const jobId = normalizeOptionalString(opts?.jobId);
	if (!raw.trim()) return [];
	const parsed = [];
	const lines = raw.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]?.trim();
		if (!line) continue;
		try {
			const obj = JSON.parse(line);
			if (!obj || typeof obj !== "object") continue;
			if (obj.action !== "finished") continue;
			if (typeof obj.jobId !== "string" || obj.jobId.trim().length === 0) continue;
			if (typeof obj.ts !== "number" || !Number.isFinite(obj.ts)) continue;
			if (jobId && obj.jobId !== jobId) continue;
			const usage = obj.usage && typeof obj.usage === "object" ? obj.usage : void 0;
			const entry = {
				ts: obj.ts,
				jobId: obj.jobId,
				action: "finished",
				status: obj.status,
				error: obj.error,
				summary: obj.summary,
				runId: typeof obj.runId === "string" && obj.runId.trim() ? obj.runId : void 0,
				diagnostics: normalizeCronRunDiagnostics(obj.diagnostics),
				runAtMs: obj.runAtMs,
				durationMs: obj.durationMs,
				nextRunAtMs: obj.nextRunAtMs,
				model: typeof obj.model === "string" && obj.model.trim() ? obj.model : void 0,
				provider: typeof obj.provider === "string" && obj.provider.trim() ? obj.provider : void 0,
				usage: usage ? {
					input_tokens: typeof usage.input_tokens === "number" ? usage.input_tokens : void 0,
					output_tokens: typeof usage.output_tokens === "number" ? usage.output_tokens : void 0,
					total_tokens: typeof usage.total_tokens === "number" ? usage.total_tokens : void 0,
					cache_read_tokens: typeof usage.cache_read_tokens === "number" ? usage.cache_read_tokens : void 0,
					cache_write_tokens: typeof usage.cache_write_tokens === "number" ? usage.cache_write_tokens : void 0
				} : void 0
			};
			if (typeof obj.delivered === "boolean") entry.delivered = obj.delivered;
			if (obj.deliveryStatus === "delivered" || obj.deliveryStatus === "not-delivered" || obj.deliveryStatus === "unknown" || obj.deliveryStatus === "not-requested") entry.deliveryStatus = obj.deliveryStatus;
			if (typeof obj.deliveryError === "string") entry.deliveryError = obj.deliveryError;
			if (obj.failureNotificationDelivery && typeof obj.failureNotificationDelivery === "object") {
				const failureNotificationDelivery = obj.failureNotificationDelivery;
				if (failureNotificationDelivery.status === "delivered" || failureNotificationDelivery.status === "not-delivered" || failureNotificationDelivery.status === "unknown" || failureNotificationDelivery.status === "not-requested") entry.failureNotificationDelivery = {
					status: failureNotificationDelivery.status,
					...typeof failureNotificationDelivery.delivered === "boolean" ? { delivered: failureNotificationDelivery.delivered } : {},
					...typeof failureNotificationDelivery.error === "string" ? { error: failureNotificationDelivery.error } : {}
				};
			}
			if (obj.delivery && typeof obj.delivery === "object") entry.delivery = obj.delivery;
			if (typeof obj.sessionId === "string" && obj.sessionId.trim().length > 0) entry.sessionId = obj.sessionId;
			if (typeof obj.sessionKey === "string" && obj.sessionKey.trim().length > 0) entry.sessionKey = obj.sessionKey;
			parsed.push(entry);
		} catch {}
	}
	return parsed;
}
function runIdMatches(entry, runId) {
	const normalized = normalizeOptionalString(runId);
	return !normalized || entry.runId === normalized;
}
function filterRunLogEntries(entries, opts) {
	return entries.filter((entry) => {
		if (!runIdMatches(entry, opts.runId)) return false;
		if (opts.statuses && (!entry.status || !opts.statuses.includes(entry.status))) return false;
		if (opts.deliveryStatuses) {
			const deliveryStatus = entry.deliveryStatus ?? "not-requested";
			if (!opts.deliveryStatuses.includes(deliveryStatus)) return false;
		}
		if (!opts.query) return true;
		return normalizeLowercaseStringOrEmpty(opts.queryTextForEntry(entry)).includes(opts.query);
	});
}
async function readCronRunLogEntriesPage(filePath, opts) {
	await drainPendingWrite(filePath);
	const limit = Math.max(1, Math.min(200, Math.floor(opts?.limit ?? 50)));
	const raw = await fs$1.readFile(path.resolve(filePath), "utf-8").catch(() => "");
	const statuses = normalizeRunStatuses(opts);
	const deliveryStatuses = normalizeDeliveryStatuses(opts);
	const query = normalizeLowercaseStringOrEmpty(opts?.query);
	const sortDir = opts?.sortDir === "asc" ? "asc" : "desc";
	const filtered = filterRunLogEntries(parseAllRunLogEntries(raw, { jobId: opts?.jobId }), {
		runId: opts?.runId,
		statuses,
		deliveryStatuses,
		query,
		queryTextForEntry: (entry) => [
			entry.summary ?? "",
			entry.error ?? "",
			entry.diagnostics?.summary ?? "",
			...(entry.diagnostics?.entries ?? []).map((diagnostic) => diagnostic.message),
			entry.jobId,
			entry.delivery?.intended?.channel ?? "",
			entry.delivery?.resolved?.channel ?? "",
			...(entry.delivery?.messageToolSentTo ?? []).map((target) => target.channel)
		].join(" ")
	});
	const sorted = sortDir === "asc" ? filtered.toSorted((a, b) => a.ts - b.ts) : filtered.toSorted((a, b) => b.ts - a.ts);
	const total = sorted.length;
	const offset = Math.max(0, Math.min(total, Math.floor(opts?.offset ?? 0)));
	const entries = sorted.slice(offset, offset + limit);
	const nextOffset = offset + entries.length;
	return {
		entries,
		total,
		offset,
		limit,
		hasMore: nextOffset < total,
		nextOffset: nextOffset < total ? nextOffset : null
	};
}
async function readCronRunLogEntriesPageAll(opts) {
	const limit = Math.max(1, Math.min(200, Math.floor(opts.limit ?? 50)));
	const statuses = normalizeRunStatuses(opts);
	const deliveryStatuses = normalizeDeliveryStatuses(opts);
	const query = normalizeLowercaseStringOrEmpty(opts.query);
	const sortDir = opts.sortDir === "asc" ? "asc" : "desc";
	const runsDir = path.resolve(path.dirname(path.resolve(opts.storePath)), "runs");
	if (!await pathExists(runsDir)) return {
		entries: [],
		total: 0,
		offset: 0,
		limit,
		hasMore: false,
		nextOffset: null
	};
	const runsRoot = await root(runsDir).catch(() => null);
	if (!runsRoot) return {
		entries: [],
		total: 0,
		offset: 0,
		limit,
		hasMore: false,
		nextOffset: null
	};
	const jsonlFiles = (await runsRoot.list(".", { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isFile && entry.name.endsWith(".jsonl")).map((entry) => entry.name);
	if (jsonlFiles.length === 0) return {
		entries: [],
		total: 0,
		offset: 0,
		limit,
		hasMore: false,
		nextOffset: null
	};
	await Promise.all(jsonlFiles.map((fileName) => drainPendingWrite(path.join(runsDir, fileName))));
	const filtered = filterRunLogEntries((await Promise.all(jsonlFiles.map(async (fileName) => {
		return parseAllRunLogEntries(await runsRoot.readText(fileName).catch(() => ""));
	}))).flat(), {
		runId: opts.runId,
		statuses,
		deliveryStatuses,
		query,
		queryTextForEntry: (entry) => {
			const jobName = opts.jobNameById?.[entry.jobId] ?? "";
			return [
				entry.summary ?? "",
				entry.error ?? "",
				entry.diagnostics?.summary ?? "",
				...(entry.diagnostics?.entries ?? []).map((diagnostic) => diagnostic.message),
				entry.jobId,
				jobName,
				entry.delivery?.intended?.channel ?? "",
				entry.delivery?.resolved?.channel ?? "",
				...(entry.delivery?.messageToolSentTo ?? []).map((target) => target.channel)
			].join(" ");
		}
	});
	const sorted = sortDir === "asc" ? filtered.toSorted((a, b) => a.ts - b.ts) : filtered.toSorted((a, b) => b.ts - a.ts);
	const total = sorted.length;
	const offset = Math.max(0, Math.min(total, Math.floor(opts.offset ?? 0)));
	const entries = sorted.slice(offset, offset + limit);
	if (opts.jobNameById) for (const entry of entries) {
		const jobName = opts.jobNameById[entry.jobId];
		if (jobName) entry.jobName = jobName;
	}
	const nextOffset = offset + entries.length;
	return {
		entries,
		total,
		offset,
		limit,
		hasMore: nextOffset < total,
		nextOffset: nextOffset < total ? nextOffset : null
	};
}
//#endregion
export { resolveCronRunLogPath as a, readCronRunLogEntriesSync as i, readCronRunLogEntriesPage as n, resolveCronRunLogPruneOptions as o, readCronRunLogEntriesPageAll as r, appendCronRunLog as t };
