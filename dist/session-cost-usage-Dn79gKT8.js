import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { n as replaceFileAtomic } from "./replace-file-C7_Inj8B.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { c as isUsageCountedSessionTranscriptFileName, d as parseUsageCountedSessionIdFromFileName, i as isSessionArchiveArtifactName, r as isPrimarySessionTranscriptFileName, u as parseSessionArchiveTimestamp } from "./artifacts-BZhcmsUl.js";
import { i as resolveSessionFilePath, l as resolveSessionTranscriptsDirForAgent } from "./paths-Bg3PO6Gj.js";
import { t as asFiniteNumber } from "./number-coercion-CgoBR0cm.js";
import { n as stripInboundMetadata } from "./strip-inbound-meta-D2-__BeH.js";
import { T as stripMessageIdHints, _ as countToolResults, v as extractToolCallNames, w as stripEnvelope } from "./session-utils.fs-CsnHXIqH.js";
import { o as normalizeUsage } from "./usage-DKNTRfvn.js";
import { a as resolveModelCostConfig, o as resolveModelCostConfigFingerprint, t as estimateUsageCost } from "./usage-format-BEywPhmZ.js";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
//#region src/infra/session-cost-usage.ts
const emptyTotals = () => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	totalCost: 0,
	inputCost: 0,
	outputCost: 0,
	cacheReadCost: 0,
	cacheWriteCost: 0,
	missingCostEntries: 0
});
const USAGE_COST_CACHE_VERSION = 3;
const USAGE_COST_CACHE_FILE = ".usage-cost-cache.json";
const USAGE_COST_CACHE_LOCK_WRITE_GRACE_MS = 1e4;
const logger = createSubsystemLogger("usage-cost-cache");
const usageCostRefreshes = /* @__PURE__ */ new Map();
const cloneTotals = (totals) => ({
	input: totals.input,
	output: totals.output,
	cacheRead: totals.cacheRead,
	cacheWrite: totals.cacheWrite,
	totalTokens: totals.totalTokens,
	totalCost: totals.totalCost,
	inputCost: totals.inputCost,
	outputCost: totals.outputCost,
	cacheReadCost: totals.cacheReadCost,
	cacheWriteCost: totals.cacheWriteCost,
	missingCostEntries: totals.missingCostEntries
});
const addTotals = (target, source) => {
	target.input += source.input;
	target.output += source.output;
	target.cacheRead += source.cacheRead;
	target.cacheWrite += source.cacheWrite;
	target.totalTokens += source.totalTokens;
	target.totalCost += source.totalCost;
	target.inputCost += source.inputCost;
	target.outputCost += source.outputCost;
	target.cacheReadCost += source.cacheReadCost;
	target.cacheWriteCost += source.cacheWriteCost;
	target.missingCostEntries += source.missingCostEntries;
};
function resolveUsageCostPricingFingerprint(config) {
	return resolveModelCostConfigFingerprint(config);
}
function resolveUsageCostCachePath(agentId) {
	return path.join(resolveSessionTranscriptsDirForAgent(agentId), USAGE_COST_CACHE_FILE);
}
function resolveUsageCostCacheLockPath(cachePath) {
	return `${cachePath}.lock`;
}
function parseUsageCostCacheLock(raw) {
	const parsed = JSON.parse(raw);
	if (!parsed || typeof parsed !== "object") return null;
	const lock = parsed;
	if (typeof lock.pid !== "number" || !Number.isInteger(lock.pid) || lock.pid <= 0 || typeof lock.startedAt !== "number" || !Number.isFinite(lock.startedAt) || lock.token !== void 0 && typeof lock.token !== "string") return null;
	return {
		pid: lock.pid,
		startedAt: lock.startedAt,
		token: lock.token
	};
}
async function readUsageCostCacheLockState(lockPath) {
	try {
		const lock = parseUsageCostCacheLock(await fs.promises.readFile(lockPath, "utf-8"));
		if (lock) return {
			state: "valid",
			lock
		};
	} catch (err) {
		if (err.code === "ENOENT") return { state: "missing" };
	}
	const stats = await fs.promises.stat(lockPath).catch(() => null);
	if (!stats) return { state: "missing" };
	return {
		state: "malformed",
		mtimeMs: stats.mtimeMs
	};
}
async function readUsageCostCacheLock(lockPath) {
	const result = await readUsageCostCacheLockState(lockPath);
	return result.state === "valid" ? result.lock : null;
}
function isMalformedUsageCostCacheLockRecent(mtimeMs) {
	return Date.now() - mtimeMs < USAGE_COST_CACHE_LOCK_WRITE_GRACE_MS;
}
async function writeUsageCostCacheLockAtomically(lockPath, lock) {
	const tempPath = `${lockPath}.${process.pid}.${process.hrtime.bigint()}.tmp`;
	await fs.promises.writeFile(tempPath, `${JSON.stringify(lock)}\n`, { flag: "wx" });
	try {
		await fs.promises.link(tempPath, lockPath);
	} finally {
		await fs.promises.rm(tempPath, { force: true }).catch(() => void 0);
	}
}
function isProcessRunning(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return err.code === "EPERM";
	}
}
async function isUsageCostCacheRefreshRunning(cachePath) {
	const lockPath = resolveUsageCostCacheLockPath(cachePath);
	const result = await readUsageCostCacheLockState(lockPath);
	if (result.state === "missing") return false;
	if (result.state === "malformed") {
		if (isMalformedUsageCostCacheLockRecent(result.mtimeMs)) return true;
		await fs.promises.rm(lockPath, { force: true }).catch(() => void 0);
		return false;
	}
	const lock = result.lock;
	if (isProcessRunning(lock.pid)) return true;
	await fs.promises.rm(lockPath, { force: true }).catch(() => void 0);
	return false;
}
async function acquireUsageCostCacheRefreshLock(cachePath) {
	const lockPath = resolveUsageCostCacheLockPath(cachePath);
	await fs.promises.mkdir(path.dirname(lockPath), { recursive: true });
	const lock = {
		pid: process.pid,
		startedAt: Date.now(),
		token: `${process.pid}:${Date.now()}:${process.hrtime.bigint()}`
	};
	try {
		await writeUsageCostCacheLockAtomically(lockPath, lock);
		return {
			acquired: true,
			release: async () => {
				const current = await readUsageCostCacheLock(lockPath);
				if (current?.pid === lock.pid && current.startedAt === lock.startedAt && current.token === lock.token) await fs.promises.rm(lockPath, { force: true }).catch(() => void 0);
			}
		};
	} catch (err) {
		if (err.code !== "EEXIST") throw err;
		if (await isUsageCostCacheRefreshRunning(cachePath)) return {
			acquired: false,
			release: async () => void 0
		};
		await fs.promises.rm(lockPath, { force: true }).catch(() => void 0);
		return acquireUsageCostCacheRefreshLock(cachePath);
	}
}
function normalizeUsageCostCache(raw) {
	if (!raw || typeof raw !== "object") return {
		version: USAGE_COST_CACHE_VERSION,
		updatedAt: 0,
		files: {}
	};
	const record = raw;
	if (record.version !== USAGE_COST_CACHE_VERSION || !record.files || typeof record.files !== "object") return {
		version: USAGE_COST_CACHE_VERSION,
		updatedAt: 0,
		files: {}
	};
	return {
		version: USAGE_COST_CACHE_VERSION,
		updatedAt: asFiniteNumber(record.updatedAt) ?? 0,
		files: record.files
	};
}
async function readUsageCostCache(cachePath) {
	try {
		const raw = await fs.promises.readFile(cachePath, "utf-8");
		return normalizeUsageCostCache(JSON.parse(raw));
	} catch {
		return {
			version: USAGE_COST_CACHE_VERSION,
			updatedAt: 0,
			files: {}
		};
	}
}
async function writeUsageCostCache(cachePath, cache) {
	await replaceFileAtomic({
		filePath: cachePath,
		content: `${JSON.stringify(cache)}\n`,
		tempPrefix: ".usage-cost-cache"
	});
}
async function listUsageCountedTranscriptFiles(agentId) {
	const sessionsDir = resolveSessionTranscriptsDirForAgent(agentId);
	const entries = await fs.promises.readdir(sessionsDir, { withFileTypes: true }).catch(() => []);
	return (await Promise.all(entries.filter((entry) => entry.isFile() && isUsageCountedSessionTranscriptFileName(entry.name)).map(async (entry) => {
		const filePath = path.join(sessionsDir, entry.name);
		const stats = await fs.promises.stat(filePath).catch(() => null);
		if (!stats) return;
		return {
			filePath,
			size: stats.size,
			mtimeMs: stats.mtimeMs
		};
	}))).filter((file) => Boolean(file));
}
function isUsageCostCacheEntryFresh(params) {
	return Boolean(params.entry && params.entry.size === params.file.size && params.entry.mtimeMs === params.file.mtimeMs && params.entry.pricingFingerprint === params.pricingFingerprint && (!params.requireSessionSummary || params.entry.sessionSummary));
}
function canUseUsageCostCacheEntryForPartial(params) {
	return Boolean(params.entry && params.entry.size <= params.file.size && params.entry.mtimeMs <= params.file.mtimeMs && params.entry.pricingFingerprint === params.pricingFingerprint);
}
function getUsageCostStaleFiles(params) {
	const sessionSummaryFiles = params.sessionSummaryFiles ?? /* @__PURE__ */ new Set();
	return params.files.filter((file) => !isUsageCostCacheEntryFresh({
		entry: params.cache.files[file.filePath],
		file,
		pricingFingerprint: params.pricingFingerprint,
		requireSessionSummary: sessionSummaryFiles.has(file.filePath)
	}));
}
function countUsableUsageCostCacheFiles(params) {
	const filesByPath = new Map(params.files.map((file) => [file.filePath, file]));
	let cachedFiles = 0;
	for (const [filePath, entry] of Object.entries(params.cache.files)) {
		const file = filesByPath.get(filePath);
		if (file && canUseUsageCostCacheEntryForPartial({
			entry,
			file,
			pricingFingerprint: params.pricingFingerprint
		})) cachedFiles += 1;
	}
	return cachedFiles;
}
function buildCostUsageSummaryFromCache(params) {
	const dailyMap = /* @__PURE__ */ new Map();
	const totals = emptyTotals();
	const filesByPath = new Map(params.files.map((file) => [file.filePath, file]));
	const staleFiles = getUsageCostStaleFiles({
		cache: params.cache,
		files: params.files,
		pricingFingerprint: params.pricingFingerprint
	});
	const cachedFiles = countUsableUsageCostCacheFiles({
		cache: params.cache,
		files: params.files,
		pricingFingerprint: params.pricingFingerprint
	});
	for (const [filePath, entry] of Object.entries(params.cache.files)) {
		const file = filesByPath.get(filePath);
		if (!file || !canUseUsageCostCacheEntryForPartial({
			entry,
			file,
			pricingFingerprint: params.pricingFingerprint
		})) continue;
		for (const usageEntry of entry.usageEntries) {
			if (usageEntry.timestamp < params.startMs || usageEntry.timestamp > params.endMs) continue;
			const date = formatDayKey(new Date(usageEntry.timestamp));
			const bucket = dailyMap.get(date) ?? emptyTotals();
			addTotals(bucket, usageEntry);
			dailyMap.set(date, bucket);
			addTotals(totals, usageEntry);
		}
	}
	const daily = Array.from(dailyMap.entries()).map(([date, bucket]) => Object.assign({ date }, bucket)).toSorted((a, b) => a.date.localeCompare(b.date));
	const days = Math.ceil((params.endMs - params.startMs) / (1440 * 60 * 1e3)) + 1;
	const status = params.refreshing ? "refreshing" : staleFiles.length > 0 ? cachedFiles > 0 ? "partial" : "stale" : "fresh";
	return {
		updatedAt: Date.now(),
		days,
		daily,
		totals,
		cacheStatus: {
			status,
			cachedFiles,
			pendingFiles: staleFiles.length,
			staleFiles: staleFiles.length,
			refreshedAt: params.cache.updatedAt || void 0
		}
	};
}
function isSessionSummaryContainedInRange(summary, startMs, endMs) {
	return (summary.firstActivity === void 0 || summary.firstActivity >= startMs) && (summary.lastActivity === void 0 || summary.lastActivity <= endMs);
}
function buildSessionCostSummaryFromCacheEntry(params) {
	if (!params.entry.transcriptEntries) return null;
	const totals = emptyTotals();
	const activityDatesSet = /* @__PURE__ */ new Set();
	const dailyMap = /* @__PURE__ */ new Map();
	const dailyMessageMap = /* @__PURE__ */ new Map();
	const utcQuarterHourMessageMap = /* @__PURE__ */ new Map();
	const utcQuarterHourTokenMap = /* @__PURE__ */ new Map();
	const dailyLatencyMap = /* @__PURE__ */ new Map();
	const dailyModelUsageMap = /* @__PURE__ */ new Map();
	const messageCounts = {
		total: 0,
		user: 0,
		assistant: 0,
		toolCalls: 0,
		toolResults: 0,
		errors: 0
	};
	const toolUsageMap = /* @__PURE__ */ new Map();
	const modelUsageMap = /* @__PURE__ */ new Map();
	const errorStopReasons = new Set([
		"error",
		"aborted",
		"timeout"
	]);
	const latencyValues = [];
	let firstActivity;
	let lastActivity;
	let lastUserTimestamp;
	const maxLatencyMs = 720 * 60 * 1e3;
	for (const entry of params.entry.transcriptEntries) {
		const ts = entry.timestamp;
		if (ts !== void 0 && ts < params.startMs) continue;
		if (ts !== void 0 && ts > params.endMs) continue;
		if (ts !== void 0) {
			firstActivity = firstActivity === void 0 ? ts : Math.min(firstActivity, ts);
			lastActivity = lastActivity === void 0 ? ts : Math.max(lastActivity, ts);
		}
		if (entry.role === "user") {
			messageCounts.user += 1;
			messageCounts.total += 1;
			if (ts !== void 0) lastUserTimestamp = ts;
		}
		if (entry.role === "assistant") {
			messageCounts.assistant += 1;
			messageCounts.total += 1;
			if (ts !== void 0) {
				const latencyMs = entry.durationMs ?? (lastUserTimestamp !== void 0 ? Math.max(0, ts - lastUserTimestamp) : void 0);
				if (latencyMs !== void 0 && Number.isFinite(latencyMs) && latencyMs <= maxLatencyMs) {
					latencyValues.push(latencyMs);
					const dayKey = formatDayKey(new Date(ts));
					const dailyLatencies = dailyLatencyMap.get(dayKey) ?? [];
					dailyLatencies.push(latencyMs);
					dailyLatencyMap.set(dayKey, dailyLatencies);
				}
			}
		}
		if (entry.toolNames.length > 0) {
			messageCounts.toolCalls += entry.toolNames.length;
			for (const name of entry.toolNames) toolUsageMap.set(name, (toolUsageMap.get(name) ?? 0) + 1);
		}
		if (entry.toolResultCounts.total > 0) {
			messageCounts.toolResults += entry.toolResultCounts.total;
			messageCounts.errors += entry.toolResultCounts.errors;
		}
		if (entry.stopReason && errorStopReasons.has(entry.stopReason)) messageCounts.errors += 1;
		if (ts !== void 0) {
			const date = new Date(ts);
			const dayKey = formatDayKey(date);
			activityDatesSet.add(dayKey);
			const daily = dailyMessageMap.get(dayKey) ?? {
				date: dayKey,
				total: 0,
				user: 0,
				assistant: 0,
				toolCalls: 0,
				toolResults: 0,
				errors: 0
			};
			daily.total += entry.role === "user" || entry.role === "assistant" ? 1 : 0;
			if (entry.role === "user") daily.user += 1;
			else if (entry.role === "assistant") daily.assistant += 1;
			daily.toolCalls += entry.toolNames.length;
			daily.toolResults += entry.toolResultCounts.total;
			daily.errors += entry.toolResultCounts.errors;
			if (entry.stopReason && errorStopReasons.has(entry.stopReason)) daily.errors += 1;
			dailyMessageMap.set(dayKey, daily);
			const quarterBucket = getUtcQuarterHourBucketKey(date);
			const utcQuarterHour = utcQuarterHourMessageMap.get(quarterBucket.key) ?? {
				date: quarterBucket.date,
				quarterIndex: quarterBucket.quarterIndex,
				total: 0,
				user: 0,
				assistant: 0,
				toolCalls: 0,
				toolResults: 0,
				errors: 0
			};
			utcQuarterHour.total += entry.role === "user" || entry.role === "assistant" ? 1 : 0;
			if (entry.role === "user") utcQuarterHour.user += 1;
			else if (entry.role === "assistant") utcQuarterHour.assistant += 1;
			utcQuarterHour.toolCalls += entry.toolNames.length;
			utcQuarterHour.toolResults += entry.toolResultCounts.total;
			utcQuarterHour.errors += entry.toolResultCounts.errors;
			if (entry.stopReason && errorStopReasons.has(entry.stopReason)) utcQuarterHour.errors += 1;
			utcQuarterHourMessageMap.set(quarterBucket.key, utcQuarterHour);
		}
		const usageTotals = entry.usageTotals;
		if (!usageTotals) continue;
		addTotals(totals, usageTotals);
		if (ts !== void 0) {
			const date = new Date(ts);
			const dayKey = formatDayKey(date);
			const componentTokens = usageTotals.input + usageTotals.output + usageTotals.cacheRead + usageTotals.cacheWrite;
			const existingDaily = dailyMap.get(dayKey) ?? {
				tokens: 0,
				cost: 0
			};
			existingDaily.tokens += componentTokens;
			existingDaily.cost += usageTotals.totalCost;
			dailyMap.set(dayKey, existingDaily);
			const quarterBucket = getUtcQuarterHourBucketKey(date);
			const utcQuarterHourToken = utcQuarterHourTokenMap.get(quarterBucket.key) ?? {
				date: quarterBucket.date,
				quarterIndex: quarterBucket.quarterIndex,
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				totalCost: 0
			};
			utcQuarterHourToken.input += usageTotals.input;
			utcQuarterHourToken.output += usageTotals.output;
			utcQuarterHourToken.cacheRead += usageTotals.cacheRead;
			utcQuarterHourToken.cacheWrite += usageTotals.cacheWrite;
			utcQuarterHourToken.totalTokens += usageTotals.totalTokens;
			utcQuarterHourToken.totalCost += usageTotals.totalCost;
			utcQuarterHourTokenMap.set(quarterBucket.key, utcQuarterHourToken);
			if (entry.provider || entry.model) {
				const dailyModelKey = `${dayKey}::${entry.provider ?? "unknown"}::${entry.model ?? "unknown"}`;
				const dailyModel = dailyModelUsageMap.get(dailyModelKey) ?? {
					date: dayKey,
					provider: entry.provider,
					model: entry.model,
					tokens: 0,
					cost: 0,
					count: 0
				};
				dailyModel.tokens += componentTokens;
				dailyModel.cost += usageTotals.totalCost;
				dailyModel.count += 1;
				dailyModelUsageMap.set(dailyModelKey, dailyModel);
			}
		}
		if (entry.provider || entry.model) {
			const modelKey = `${entry.provider ?? "unknown"}::${entry.model ?? "unknown"}`;
			const modelUsage = modelUsageMap.get(modelKey) ?? {
				provider: entry.provider,
				model: entry.model,
				count: 0,
				totals: emptyTotals()
			};
			modelUsage.count += 1;
			addTotals(modelUsage.totals, usageTotals);
			modelUsageMap.set(modelKey, modelUsage);
		}
	}
	const dailyBreakdown = Array.from(dailyMap.entries()).map(([date, data]) => ({
		date,
		tokens: data.tokens,
		cost: data.cost
	})).toSorted((a, b) => a.date.localeCompare(b.date));
	const dailyMessageCounts = Array.from(dailyMessageMap.values()).toSorted((a, b) => a.date.localeCompare(b.date));
	const utcQuarterHourMessageCounts = Array.from(utcQuarterHourMessageMap.values()).toSorted((a, b) => a.date.localeCompare(b.date) || a.quarterIndex - b.quarterIndex);
	const utcQuarterHourTokenUsage = Array.from(utcQuarterHourTokenMap.values()).toSorted((a, b) => a.date.localeCompare(b.date) || a.quarterIndex - b.quarterIndex);
	const dailyLatency = Array.from(dailyLatencyMap.entries()).map(([date, values]) => {
		const stats = computeLatencyStats(values);
		if (!stats) return null;
		return Object.assign({ date }, stats);
	}).filter((entry) => Boolean(entry)).toSorted((a, b) => a.date.localeCompare(b.date));
	const dailyModelUsage = Array.from(dailyModelUsageMap.values()).toSorted((a, b) => a.date.localeCompare(b.date) || b.cost - a.cost);
	const toolUsage = toolUsageMap.size ? {
		totalCalls: Array.from(toolUsageMap.values()).reduce((sum, count) => sum + count, 0),
		uniqueTools: toolUsageMap.size,
		tools: Array.from(toolUsageMap.entries()).map(([name, count]) => ({
			name,
			count
		})).toSorted((a, b) => b.count - a.count)
	} : void 0;
	const modelUsage = Array.from(modelUsageMap.values()).toSorted((a, b) => {
		const costDiff = (b.totals?.totalCost ?? 0) - (a.totals?.totalCost ?? 0);
		if (costDiff !== 0) return costDiff;
		return (b.totals?.totalTokens ?? 0) - (a.totals?.totalTokens ?? 0);
	});
	return {
		sessionId: params.sessionId,
		sessionFile: params.sessionFile,
		firstActivity,
		lastActivity,
		durationMs: firstActivity !== void 0 && lastActivity !== void 0 ? Math.max(0, lastActivity - firstActivity) : void 0,
		activityDates: Array.from(activityDatesSet).toSorted(),
		dailyBreakdown,
		dailyMessageCounts,
		utcQuarterHourMessageCounts: utcQuarterHourMessageCounts.length ? utcQuarterHourMessageCounts : void 0,
		utcQuarterHourTokenUsage: utcQuarterHourTokenUsage.length ? utcQuarterHourTokenUsage : void 0,
		dailyLatency: dailyLatency.length ? dailyLatency : void 0,
		dailyModelUsage: dailyModelUsage.length ? dailyModelUsage : void 0,
		messageCounts,
		toolUsage,
		modelUsage: modelUsage.length ? modelUsage : void 0,
		latency: computeLatencyStats(latencyValues),
		...totals
	};
}
const extractCostBreakdown = (usageRaw) => {
	if (!usageRaw || typeof usageRaw !== "object") return;
	const cost = usageRaw.cost;
	if (!cost) return;
	const total = asFiniteNumber(cost.total);
	if (total === void 0 || total < 0) return;
	return {
		total,
		input: asFiniteNumber(cost.input),
		output: asFiniteNumber(cost.output),
		cacheRead: asFiniteNumber(cost.cacheRead),
		cacheWrite: asFiniteNumber(cost.cacheWrite)
	};
};
const parseTimestamp = (entry) => {
	const raw = entry.timestamp;
	if (typeof raw === "string") {
		const parsed = new Date(raw);
		if (!Number.isNaN(parsed.valueOf())) return parsed;
	}
	const message = entry.message;
	const messageTimestamp = asFiniteNumber(message?.timestamp);
	if (messageTimestamp !== void 0) {
		const parsed = new Date(messageTimestamp);
		if (!Number.isNaN(parsed.valueOf())) return parsed;
	}
};
const parseTranscriptEntry = (entry) => {
	const message = entry.message;
	if (!message || typeof message !== "object") return null;
	const roleRaw = message.role;
	const role = roleRaw === "user" || roleRaw === "assistant" ? roleRaw : void 0;
	if (!role) return null;
	const usageRaw = message.usage ?? entry.usage;
	const usage = usageRaw ? normalizeUsage(usageRaw) ?? void 0 : void 0;
	const provider = (typeof message.provider === "string" ? message.provider : void 0) ?? (typeof entry.provider === "string" ? entry.provider : void 0);
	const model = (typeof message.model === "string" ? message.model : void 0) ?? (typeof entry.model === "string" ? entry.model : void 0);
	const costBreakdown = extractCostBreakdown(usageRaw);
	const stopReason = typeof message.stopReason === "string" ? message.stopReason : void 0;
	const durationMs = asFiniteNumber(message.durationMs ?? entry.durationMs);
	return {
		message,
		role,
		timestamp: parseTimestamp(entry),
		durationMs,
		usage,
		costTotal: costBreakdown?.total,
		costBreakdown,
		provider,
		model,
		stopReason,
		toolNames: extractToolCallNames(message),
		toolResultCounts: countToolResults(message)
	};
};
const formatDayKey = (date) => date.toLocaleDateString("en-CA", { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
const formatUtcDayKey = (date) => `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
const getUtcQuarterHourBucketKey = (date) => {
	const quarterIndex = Math.floor((date.getUTCHours() * 60 + date.getUTCMinutes()) / 15);
	const utcDayKey = formatUtcDayKey(date);
	return {
		date: utcDayKey,
		quarterIndex,
		key: `${utcDayKey}::${quarterIndex}`
	};
};
/**
* Accumulate message-level counts into a bucket (daily or UTC quarter-hour).
* Avoids duplicating the same logic for both daily and quarter-hour message counts.
*/
const accumulateMessageCounts = (bucket, entry, errorStopReasons) => {
	bucket.total += entry.role === "user" || entry.role === "assistant" ? 1 : 0;
	if (entry.role === "user") bucket.user += 1;
	else if (entry.role === "assistant") bucket.assistant += 1;
	bucket.toolCalls += entry.toolNames.length;
	bucket.toolResults += entry.toolResultCounts.total;
	bucket.errors += entry.toolResultCounts.errors;
	if (entry.stopReason && errorStopReasons.has(entry.stopReason)) bucket.errors += 1;
};
const computeLatencyStats = (values) => {
	if (!values.length) return;
	const sorted = values.toSorted((a, b) => a - b);
	const total = sorted.reduce((sum, v) => sum + v, 0);
	const count = sorted.length;
	const p95Index = Math.max(0, Math.ceil(count * .95) - 1);
	return {
		count,
		avgMs: total / count,
		p95Ms: sorted[p95Index] ?? sorted[count - 1],
		minMs: sorted[0],
		maxMs: sorted[count - 1]
	};
};
const computeUsageTokenTotals = (usage) => {
	const input = usage.input ?? 0;
	const output = usage.output ?? 0;
	const cacheRead = usage.cacheRead ?? 0;
	const cacheWrite = usage.cacheWrite ?? 0;
	const componentTotal = input + output + cacheRead + cacheWrite;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		componentTotal,
		totalTokens: usage.total ?? componentTotal
	};
};
const applyUsageTotals = (totals, usage) => {
	const usageTotals = computeUsageTokenTotals(usage);
	totals.input += usageTotals.input;
	totals.output += usageTotals.output;
	totals.cacheRead += usageTotals.cacheRead;
	totals.cacheWrite += usageTotals.cacheWrite;
	totals.totalTokens += usageTotals.totalTokens;
};
const applyCostBreakdown = (totals, costBreakdown) => {
	if (costBreakdown === void 0 || costBreakdown.total === void 0) return;
	totals.totalCost += costBreakdown.total;
	totals.inputCost += costBreakdown.input ?? 0;
	totals.outputCost += costBreakdown.output ?? 0;
	totals.cacheReadCost += costBreakdown.cacheRead ?? 0;
	totals.cacheWriteCost += costBreakdown.cacheWrite ?? 0;
};
const applyCostTotal = (totals, costTotal) => {
	if (costTotal === void 0) {
		totals.missingCostEntries += 1;
		return;
	}
	totals.totalCost += costTotal;
};
async function canReadJsonlFromOffset(filePath, startOffset) {
	if (startOffset <= 0) return true;
	const handle = await fs.promises.open(filePath, "r").catch(() => null);
	if (!handle) return false;
	try {
		const buffer = Buffer.alloc(1);
		return (await handle.read(buffer, 0, 1, startOffset - 1)).bytesRead === 1 && buffer[0] === 10;
	} finally {
		await handle.close().catch(() => void 0);
	}
}
async function* readJsonlRecords(filePath, startOffset = 0, endOffset) {
	if (endOffset !== void 0 && endOffset <= startOffset) return;
	const streamOptions = {
		encoding: "utf-8",
		start: Math.max(0, startOffset)
	};
	if (endOffset !== void 0) streamOptions.end = endOffset - 1;
	const fileStream = fs.createReadStream(filePath, streamOptions);
	const rl = readline.createInterface({
		input: fileStream,
		crlfDelay: Infinity
	});
	try {
		for await (const line of rl) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				const parsed = JSON.parse(trimmed);
				if (!parsed || typeof parsed !== "object") continue;
				yield parsed;
			} catch {}
		}
	} finally {
		rl.close();
		fileStream.destroy();
	}
}
async function scanTranscriptFile(params) {
	for await (const parsed of readJsonlRecords(params.filePath, params.startOffset, params.endOffset)) {
		const entry = parseTranscriptEntry(parsed);
		if (!entry) continue;
		if (entry.usage) {
			const cost = resolveModelCostConfig({
				provider: entry.provider,
				model: entry.model,
				config: params.config
			});
			if (cost?.tieredPricing && cost.tieredPricing.length > 0) {
				entry.costTotal = estimateUsageCost({
					usage: entry.usage,
					cost
				});
				entry.costBreakdown = void 0;
			} else if (entry.costTotal === void 0) entry.costTotal = estimateUsageCost({
				usage: entry.usage,
				cost
			});
		}
		params.onEntry(entry);
	}
}
async function scanUsageFile(params) {
	await scanTranscriptFile({
		filePath: params.filePath,
		config: params.config,
		startOffset: params.startOffset,
		endOffset: params.endOffset,
		onEntry: (entry) => {
			if (!entry.usage) return;
			params.onEntry({
				usage: entry.usage,
				costTotal: entry.costTotal,
				costBreakdown: entry.costBreakdown,
				provider: entry.provider,
				model: entry.model,
				timestamp: entry.timestamp
			});
		}
	});
}
function resolveExistingUsageSessionFile(params) {
	const candidate = params.sessionFile ?? (params.sessionId ? resolveSessionFilePath(params.sessionId, params.sessionEntry, { agentId: params.agentId }) : void 0);
	if (candidate && fs.existsSync(candidate)) return candidate;
	const sessionId = params.sessionId?.trim();
	if (!sessionId) return candidate;
	try {
		const sessionsDir = candidate ? path.dirname(candidate) : resolveSessionTranscriptsDirForAgent(params.agentId);
		const baseFileName = `${sessionId}.jsonl`;
		const entries = fs.readdirSync(sessionsDir, { withFileTypes: true }).filter((entry) => {
			return entry.isFile() && (entry.name === baseFileName || entry.name.startsWith(`${baseFileName}.reset.`) || entry.name.startsWith(`${baseFileName}.deleted.`));
		});
		const primary = entries.find((entry) => entry.name === baseFileName);
		if (primary) return path.join(sessionsDir, primary.name);
		const latestArchive = entries.filter((entry) => isSessionArchiveArtifactName(entry.name)).map((entry) => entry.name).toSorted((a, b) => {
			const tsA = parseSessionArchiveTimestamp(a, "deleted") ?? parseSessionArchiveTimestamp(a, "reset") ?? 0;
			return (parseSessionArchiveTimestamp(b, "deleted") ?? parseSessionArchiveTimestamp(b, "reset") ?? 0) - tsA || b.localeCompare(a);
		})[0];
		return latestArchive ? path.join(sessionsDir, latestArchive) : candidate;
	} catch {
		return candidate;
	}
}
async function loadCostUsageSummary(params) {
	const now = /* @__PURE__ */ new Date();
	let sinceTime;
	let untilTime;
	if (params?.startMs !== void 0 && params?.endMs !== void 0) {
		sinceTime = params.startMs;
		untilTime = params.endMs;
	} else {
		const days = Math.max(1, Math.floor(params?.days ?? 30));
		const since = new Date(now);
		since.setDate(since.getDate() - (days - 1));
		sinceTime = since.getTime();
		untilTime = now.getTime();
	}
	const dailyMap = /* @__PURE__ */ new Map();
	const totals = emptyTotals();
	const sessionsDir = resolveSessionTranscriptsDirForAgent(params?.agentId);
	const entries = await fs.promises.readdir(sessionsDir, { withFileTypes: true }).catch(() => []);
	const files = (await Promise.all(entries.filter((entry) => entry.isFile() && isUsageCountedSessionTranscriptFileName(entry.name)).map(async (entry) => {
		const filePath = path.join(sessionsDir, entry.name);
		const stats = await fs.promises.stat(filePath).catch(() => null);
		if (!stats) return null;
		if (stats.mtimeMs < sinceTime) return null;
		return filePath;
	}))).filter((filePath) => Boolean(filePath));
	for (const filePath of files) await scanUsageFile({
		filePath,
		config: params?.config,
		onEntry: (entry) => {
			const ts = entry.timestamp?.getTime();
			if (!ts || ts < sinceTime || ts > untilTime) return;
			const dayKey = formatDayKey(entry.timestamp ?? now);
			const bucket = dailyMap.get(dayKey) ?? emptyTotals();
			applyUsageTotals(bucket, entry.usage);
			if (entry.costBreakdown?.total !== void 0) applyCostBreakdown(bucket, entry.costBreakdown);
			else applyCostTotal(bucket, entry.costTotal);
			dailyMap.set(dayKey, bucket);
			applyUsageTotals(totals, entry.usage);
			if (entry.costBreakdown?.total !== void 0) applyCostBreakdown(totals, entry.costBreakdown);
			else applyCostTotal(totals, entry.costTotal);
		}
	});
	const daily = Array.from(dailyMap.entries()).map(([date, bucket]) => Object.assign({ date }, bucket)).toSorted((a, b) => a.date.localeCompare(b.date));
	const days = Math.ceil((untilTime - sinceTime) / (1440 * 60 * 1e3)) + 1;
	return {
		updatedAt: Date.now(),
		days,
		daily,
		totals
	};
}
async function scanUsageFileForCache(params) {
	const pricingFingerprint = resolveUsageCostPricingFingerprint(params.config);
	const appendOnlyPreviousCandidate = params.previous && params.previous.filePath === params.file.filePath && params.previous.size > 0 && params.previous.size < params.file.size && params.previous.pricingFingerprint === pricingFingerprint && params.previous.mtimeMs <= params.file.mtimeMs ? params.previous : void 0;
	const appendOnlyPrevious = appendOnlyPreviousCandidate && (!params.includeSessionSummary || appendOnlyPreviousCandidate.transcriptEntries) ? appendOnlyPreviousCandidate : void 0;
	const totals = emptyTotals();
	const usageEntries = [];
	const shouldTrackTranscriptEntries = params.includeSessionSummary || Boolean(appendOnlyPrevious?.transcriptEntries);
	const transcriptEntries = shouldTrackTranscriptEntries ? [] : void 0;
	let parsedRecords = 0;
	let countedRecords = 0;
	const startOffset = appendOnlyPrevious && await canReadJsonlFromOffset(params.file.filePath, appendOnlyPrevious.size) ? appendOnlyPrevious.size : void 0;
	await scanTranscriptFile({
		filePath: params.file.filePath,
		config: params.config,
		startOffset,
		endOffset: params.file.size,
		onEntry: (entry) => {
			const ts = entry.timestamp?.getTime();
			let entryTotals;
			if (entry.usage) {
				parsedRecords += 1;
				entryTotals = emptyTotals();
				applyUsageTotals(entryTotals, entry.usage);
				if (entry.costBreakdown?.total !== void 0) applyCostBreakdown(entryTotals, entry.costBreakdown);
				else applyCostTotal(entryTotals, entry.costTotal);
				addTotals(totals, entryTotals);
				if (ts !== void 0) {
					countedRecords += 1;
					usageEntries.push({
						timestamp: ts,
						provider: entry.provider,
						model: entry.model,
						...entryTotals
					});
				}
			}
			transcriptEntries?.push({
				timestamp: ts,
				role: entry.role,
				durationMs: entry.durationMs,
				provider: entry.provider,
				model: entry.model,
				stopReason: entry.stopReason,
				toolNames: entry.toolNames,
				toolResultCounts: entry.toolResultCounts,
				usageTotals: entryTotals ? cloneTotals(entryTotals) : void 0
			});
		}
	});
	const sessionId = parseUsageCountedSessionIdFromFileName(path.basename(params.file.filePath)) ?? void 0;
	const combinedTranscriptEntries = shouldTrackTranscriptEntries ? [...(appendOnlyPrevious && startOffset !== void 0 ? appendOnlyPrevious.transcriptEntries : void 0) ?? [], ...transcriptEntries ?? []] : void 0;
	const sessionSummary = combinedTranscriptEntries && (params.includeSessionSummary || appendOnlyPrevious?.sessionSummary) ? buildSessionCostSummaryFromCacheEntry({
		entry: {
			filePath: params.file.filePath,
			size: params.file.size,
			mtimeMs: params.file.mtimeMs,
			pricingFingerprint,
			scannedAt: Date.now(),
			parsedRecords,
			countedRecords,
			usageEntries,
			transcriptEntries: combinedTranscriptEntries,
			totals,
			sessionId
		},
		sessionId,
		sessionFile: params.file.filePath,
		startMs: Number.NEGATIVE_INFINITY,
		endMs: Number.POSITIVE_INFINITY
	}) ?? void 0 : void 0;
	if (appendOnlyPrevious && startOffset !== void 0) {
		const previousTotals = cloneTotals(appendOnlyPrevious.totals);
		addTotals(previousTotals, totals);
		return {
			...appendOnlyPrevious,
			size: params.file.size,
			mtimeMs: params.file.mtimeMs,
			pricingFingerprint,
			scannedAt: Date.now(),
			parsedRecords: appendOnlyPrevious.parsedRecords + parsedRecords,
			countedRecords: appendOnlyPrevious.countedRecords + countedRecords,
			usageEntries: [...appendOnlyPrevious.usageEntries, ...usageEntries],
			transcriptEntries: combinedTranscriptEntries,
			totals: previousTotals,
			sessionSummary
		};
	}
	return {
		filePath: params.file.filePath,
		size: params.file.size,
		mtimeMs: params.file.mtimeMs,
		pricingFingerprint,
		scannedAt: Date.now(),
		parsedRecords,
		countedRecords,
		usageEntries,
		transcriptEntries: combinedTranscriptEntries,
		totals,
		sessionId,
		sessionSummary
	};
}
async function refreshCostUsageCache(params) {
	const cachePath = resolveUsageCostCachePath(params?.agentId);
	const lock = await acquireUsageCostCacheRefreshLock(cachePath);
	if (!lock.acquired) return "busy";
	try {
		const pricingFingerprint = resolveUsageCostPricingFingerprint(params?.config);
		const cache = await readUsageCostCache(cachePath);
		const files = await listUsageCountedTranscriptFiles(params?.agentId);
		const sessionSummaryFiles = new Set(params?.sessionFiles ?? []);
		const refreshStartMs = params?.startMs;
		const refreshFiles = sessionSummaryFiles.size > 0 ? files.filter((file) => sessionSummaryFiles.has(file.filePath)) : refreshStartMs === void 0 ? files : files.filter((file) => file.mtimeMs >= refreshStartMs);
		const livePaths = new Set(files.map((file) => file.filePath));
		for (const filePath of Object.keys(cache.files)) if (!livePaths.has(filePath)) delete cache.files[filePath];
		const maxFiles = params?.maxFiles !== void 0 && Number.isFinite(params.maxFiles) && params.maxFiles > 0 ? Math.floor(params.maxFiles) : void 0;
		const staleFiles = getUsageCostStaleFiles({
			cache,
			files: refreshFiles,
			pricingFingerprint,
			sessionSummaryFiles
		}).toSorted((a, b) => {
			return (sessionSummaryFiles.has(a.filePath) ? 0 : 1) - (sessionSummaryFiles.has(b.filePath) ? 0 : 1) || a.size - b.size || a.filePath.localeCompare(b.filePath);
		}).slice(0, maxFiles);
		for (const file of staleFiles) {
			cache.files[file.filePath] = await scanUsageFileForCache({
				file,
				config: params?.config,
				previous: cache.files[file.filePath],
				includeSessionSummary: sessionSummaryFiles.has(file.filePath)
			});
			cache.updatedAt = Date.now();
			await writeUsageCostCache(cachePath, cache);
		}
		cache.updatedAt = Date.now();
		await writeUsageCostCache(cachePath, cache);
		return "refreshed";
	} finally {
		await lock.release();
	}
}
async function loadCostUsageSummaryFromCache(params) {
	const cachePath = resolveUsageCostCachePath(params.agentId);
	const pricingFingerprint = resolveUsageCostPricingFingerprint(params.config);
	let [cache, files] = await Promise.all([readUsageCostCache(cachePath), listUsageCountedTranscriptFiles(params.agentId)]);
	const staleFiles = getUsageCostStaleFiles({
		cache,
		files,
		pricingFingerprint
	});
	if (params.requestRefresh !== false && staleFiles.length > 0) {
		const cachedFiles = countUsableUsageCostCacheFiles({
			cache,
			files,
			pricingFingerprint
		});
		if (params.refreshMode === "sync-when-empty" && cachedFiles === 0) {
			const result = await refreshCostUsageCache({
				config: params.config,
				agentId: params.agentId,
				startMs: params.startMs
			});
			[cache, files] = await Promise.all([readUsageCostCache(cachePath), listUsageCountedTranscriptFiles(params.agentId)]);
			if (result === "refreshed") {
				if (getUsageCostStaleFiles({
					cache,
					files,
					pricingFingerprint
				}).length > 0) requestCostUsageCacheRefresh({
					config: params.config,
					agentId: params.agentId
				});
			}
		} else requestCostUsageCacheRefresh({
			config: params.config,
			agentId: params.agentId
		});
	}
	const refreshRunning = await isUsageCostCacheRefreshRunning(cachePath);
	return buildCostUsageSummaryFromCache({
		cache,
		files,
		startMs: params.startMs,
		endMs: params.endMs,
		pricingFingerprint,
		refreshing: usageCostRefreshes.has(params.agentId ?? "main") || refreshRunning
	});
}
async function loadSessionCostSummaryFromCache(params) {
	const cachePath = resolveUsageCostCachePath(params.agentId);
	const pricingFingerprint = resolveUsageCostPricingFingerprint(params.config);
	let [cache, stats] = await Promise.all([readUsageCostCache(cachePath), fs.promises.stat(params.sessionFile).catch(() => null)]);
	let file = stats ? {
		filePath: params.sessionFile,
		size: stats.size,
		mtimeMs: stats.mtimeMs
	} : void 0;
	let entry = cache.files[params.sessionFile];
	let stale = !file || !isUsageCostCacheEntryFresh({
		entry,
		file,
		pricingFingerprint,
		requireSessionSummary: true
	});
	let refreshRequested = false;
	if (params.requestRefresh !== false && stale) if (params.refreshMode === "sync-when-empty") if (await refreshCostUsageCache({
		config: params.config,
		agentId: params.agentId,
		sessionFiles: [params.sessionFile]
	}) === "refreshed") {
		[cache, stats] = await Promise.all([readUsageCostCache(cachePath), fs.promises.stat(params.sessionFile).catch(() => null)]);
		file = stats ? {
			filePath: params.sessionFile,
			size: stats.size,
			mtimeMs: stats.mtimeMs
		} : void 0;
		entry = cache.files[params.sessionFile];
		stale = !file || !isUsageCostCacheEntryFresh({
			entry,
			file,
			pricingFingerprint,
			requireSessionSummary: true
		});
	} else {
		requestCostUsageCacheRefresh({
			config: params.config,
			agentId: params.agentId,
			sessionFiles: [params.sessionFile]
		});
		refreshRequested = true;
	}
	else {
		requestCostUsageCacheRefresh({
			config: params.config,
			agentId: params.agentId,
			sessionFiles: [params.sessionFile]
		});
		refreshRequested = true;
	}
	const refreshRunning = await isUsageCostCacheRefreshRunning(cachePath);
	let summary = stale ? null : entry?.sessionSummary ?? null;
	if (!summary && params.refreshMode === "sync-when-empty") summary = await loadSessionCostSummary({
		sessionId: params.sessionId,
		sessionEntry: params.sessionEntry,
		sessionFile: params.sessionFile,
		config: params.config,
		agentId: params.agentId,
		startMs: params.startMs,
		endMs: params.endMs
	});
	if (summary && params.startMs !== void 0 && params.endMs !== void 0 && !isSessionSummaryContainedInRange(summary, params.startMs, params.endMs)) summary = entry ? buildSessionCostSummaryFromCacheEntry({
		entry,
		sessionId: params.sessionId,
		sessionFile: params.sessionFile,
		startMs: params.startMs,
		endMs: params.endMs
	}) : params.refreshMode === "sync-when-empty" ? await loadSessionCostSummary({
		sessionId: params.sessionId,
		sessionEntry: params.sessionEntry,
		sessionFile: params.sessionFile,
		config: params.config,
		agentId: params.agentId,
		startMs: params.startMs,
		endMs: params.endMs
	}) : null;
	return {
		summary,
		cacheStatus: {
			status: stale ? refreshRunning || refreshRequested ? "refreshing" : summary ? "partial" : "stale" : "fresh",
			cachedFiles: stale ? 0 : 1,
			pendingFiles: stale ? 1 : 0,
			staleFiles: stale ? 1 : 0,
			refreshedAt: cache.updatedAt || void 0
		}
	};
}
function requestCostUsageCacheRefresh(params) {
	const agentId = params?.agentId ?? "main";
	const existing = usageCostRefreshes.get(agentId);
	if (existing) {
		mergeUsageCostRefreshRequest(existing, params);
		return;
	}
	const state = {
		agentId: params?.agentId,
		config: params?.config,
		fullRefreshRequested: false,
		pendingSessionFiles: /* @__PURE__ */ new Set(),
		running: false
	};
	mergeUsageCostRefreshRequest(state, params);
	usageCostRefreshes.set(agentId, state);
	scheduleUsageCostRefresh(agentId, state);
}
function mergeUsageCostRefreshRequest(state, params) {
	if (params?.config) state.config = params.config;
	if (params?.agentId) state.agentId = params.agentId;
	if (!params?.sessionFiles) {
		state.fullRefreshRequested = true;
		return;
	}
	for (const sessionFile of params.sessionFiles) state.pendingSessionFiles.add(sessionFile);
}
function scheduleUsageCostRefresh(agentId, state, delayMs = 0) {
	if (state.running || state.timer) return;
	const timer = setTimeout(() => {
		state.timer = void 0;
		runQueuedUsageCostRefresh(agentId, state);
	}, delayMs);
	timer.unref?.();
	state.timer = timer;
}
async function runQueuedUsageCostRefresh(agentId, state) {
	state.running = true;
	let retryDelayMs = 0;
	try {
		while (state.fullRefreshRequested || state.pendingSessionFiles.size > 0) {
			const fullRefreshRequested = state.fullRefreshRequested;
			const sessionFiles = fullRefreshRequested ? [] : [...state.pendingSessionFiles];
			if (!fullRefreshRequested) state.pendingSessionFiles.clear();
			state.fullRefreshRequested = false;
			if (await refreshCostUsageCache({
				config: state.config,
				agentId: state.agentId,
				sessionFiles: fullRefreshRequested ? void 0 : sessionFiles
			}) === "busy") {
				if (fullRefreshRequested) state.fullRefreshRequested = true;
				else for (const sessionFile of sessionFiles) state.pendingSessionFiles.add(sessionFile);
				retryDelayMs = 50;
				break;
			}
		}
	} catch (error) {
		logger.warn(`background refresh failed: ${formatErrorMessage(error)}`, { error });
	} finally {
		state.running = false;
		if (state.fullRefreshRequested || state.pendingSessionFiles.size > 0) scheduleUsageCostRefresh(agentId, state, retryDelayMs);
		else usageCostRefreshes.delete(agentId);
	}
}
/**
* Scan all transcript files to discover sessions not in the session store.
* Returns basic metadata for each discovered session.
*/
async function discoverAllSessions(params) {
	const sessionsDir = resolveSessionTranscriptsDirForAgent(params?.agentId);
	const entries = await fs.promises.readdir(sessionsDir, { withFileTypes: true }).catch(() => []);
	const discovered = /* @__PURE__ */ new Map();
	for (const entry of entries) {
		if (!entry.isFile() || !isUsageCountedSessionTranscriptFileName(entry.name)) continue;
		const filePath = path.join(sessionsDir, entry.name);
		const stats = await fs.promises.stat(filePath).catch(() => null);
		if (!stats) continue;
		if (params?.startMs && stats.mtimeMs < params.startMs) continue;
		const sessionId = parseUsageCountedSessionIdFromFileName(entry.name);
		if (!sessionId) continue;
		const isPrimaryTranscript = isPrimarySessionTranscriptFileName(entry.name);
		let firstUserMessage;
		if (params?.includeFirstUserMessage !== false) try {
			for await (const parsed of readJsonlRecords(filePath)) try {
				const message = parsed.message;
				if (message?.role === "user") {
					const content = message.content;
					if (typeof content === "string") firstUserMessage = content.slice(0, 100);
					else if (Array.isArray(content)) {
						for (const block of content) if (typeof block === "object" && block && block.type === "text") {
							const text = block.text;
							if (typeof text === "string") firstUserMessage = text.slice(0, 100);
							break;
						}
					}
					break;
				}
			} catch {}
		} catch {}
		const existing = discovered.get(sessionId);
		const existingIsPrimary = existing ? isPrimarySessionTranscriptFileName(path.basename(existing.sessionFile)) : false;
		if (!existing || isPrimaryTranscript && !existingIsPrimary || isPrimaryTranscript === existingIsPrimary && stats.mtimeMs >= existing.mtime) {
			discovered.set(sessionId, {
				sessionId,
				sessionFile: filePath,
				mtime: stats.mtimeMs,
				firstUserMessage: firstUserMessage ?? existing?.firstUserMessage
			});
			continue;
		}
		if (!existing.firstUserMessage && firstUserMessage) {
			existing.firstUserMessage = firstUserMessage;
			discovered.set(sessionId, existing);
		}
	}
	return Array.from(discovered.values()).toSorted((a, b) => b.mtime - a.mtime);
}
async function loadSessionCostSummary(params) {
	const sessionFile = resolveExistingUsageSessionFile(params);
	if (!sessionFile || !fs.existsSync(sessionFile)) return null;
	const totals = emptyTotals();
	let firstActivity;
	let lastActivity;
	const activityDatesSet = /* @__PURE__ */ new Set();
	const dailyMap = /* @__PURE__ */ new Map();
	const dailyMessageMap = /* @__PURE__ */ new Map();
	const utcQuarterHourMessageMap = /* @__PURE__ */ new Map();
	const utcQuarterHourTokenMap = /* @__PURE__ */ new Map();
	const dailyLatencyMap = /* @__PURE__ */ new Map();
	const dailyModelUsageMap = /* @__PURE__ */ new Map();
	const messageCounts = {
		total: 0,
		user: 0,
		assistant: 0,
		toolCalls: 0,
		toolResults: 0,
		errors: 0
	};
	const toolUsageMap = /* @__PURE__ */ new Map();
	const modelUsageMap = /* @__PURE__ */ new Map();
	const errorStopReasons = new Set([
		"error",
		"aborted",
		"timeout"
	]);
	const latencyValues = [];
	let lastUserTimestamp;
	const MAX_LATENCY_MS = 720 * 60 * 1e3;
	await scanTranscriptFile({
		filePath: sessionFile,
		config: params.config,
		onEntry: (entry) => {
			const ts = entry.timestamp?.getTime();
			if (params.startMs !== void 0 && ts !== void 0 && ts < params.startMs) return;
			if (params.endMs !== void 0 && ts !== void 0 && ts > params.endMs) return;
			if (ts !== void 0) {
				if (!firstActivity || ts < firstActivity) firstActivity = ts;
				if (!lastActivity || ts > lastActivity) lastActivity = ts;
			}
			if (entry.role === "user") {
				messageCounts.user += 1;
				messageCounts.total += 1;
				if (entry.timestamp) lastUserTimestamp = entry.timestamp.getTime();
			}
			if (entry.role === "assistant") {
				messageCounts.assistant += 1;
				messageCounts.total += 1;
				const ts = entry.timestamp?.getTime();
				if (ts !== void 0) {
					const latencyMs = entry.durationMs ?? (lastUserTimestamp !== void 0 ? Math.max(0, ts - lastUserTimestamp) : void 0);
					if (latencyMs !== void 0 && Number.isFinite(latencyMs) && latencyMs <= MAX_LATENCY_MS) {
						latencyValues.push(latencyMs);
						const dayKey = formatDayKey(entry.timestamp ?? new Date(ts));
						const dailyLatencies = dailyLatencyMap.get(dayKey) ?? [];
						dailyLatencies.push(latencyMs);
						dailyLatencyMap.set(dayKey, dailyLatencies);
					}
				}
			}
			if (entry.toolNames.length > 0) {
				messageCounts.toolCalls += entry.toolNames.length;
				for (const name of entry.toolNames) toolUsageMap.set(name, (toolUsageMap.get(name) ?? 0) + 1);
			}
			if (entry.toolResultCounts.total > 0) {
				messageCounts.toolResults += entry.toolResultCounts.total;
				messageCounts.errors += entry.toolResultCounts.errors;
			}
			if (entry.stopReason && errorStopReasons.has(entry.stopReason)) messageCounts.errors += 1;
			if (entry.timestamp) {
				const dayKey = formatDayKey(entry.timestamp);
				activityDatesSet.add(dayKey);
				const daily = dailyMessageMap.get(dayKey) ?? {
					date: dayKey,
					total: 0,
					user: 0,
					assistant: 0,
					toolCalls: 0,
					toolResults: 0,
					errors: 0
				};
				accumulateMessageCounts(daily, entry, errorStopReasons);
				dailyMessageMap.set(dayKey, daily);
				const quarterBucket = getUtcQuarterHourBucketKey(entry.timestamp);
				const utcQuarterHour = utcQuarterHourMessageMap.get(quarterBucket.key) ?? {
					date: quarterBucket.date,
					quarterIndex: quarterBucket.quarterIndex,
					total: 0,
					user: 0,
					assistant: 0,
					toolCalls: 0,
					toolResults: 0,
					errors: 0
				};
				accumulateMessageCounts(utcQuarterHour, entry, errorStopReasons);
				utcQuarterHourMessageMap.set(quarterBucket.key, utcQuarterHour);
			}
			if (!entry.usage) return;
			applyUsageTotals(totals, entry.usage);
			if (entry.costBreakdown?.total !== void 0) applyCostBreakdown(totals, entry.costBreakdown);
			else applyCostTotal(totals, entry.costTotal);
			if (entry.timestamp) {
				const dayKey = formatDayKey(entry.timestamp);
				const entryTokenTotals = computeUsageTokenTotals(entry.usage);
				const entryTokens = entryTokenTotals.componentTotal;
				const entryCost = entry.costBreakdown?.total ?? (entry.costBreakdown ? (entry.costBreakdown.input ?? 0) + (entry.costBreakdown.output ?? 0) + (entry.costBreakdown.cacheRead ?? 0) + (entry.costBreakdown.cacheWrite ?? 0) : entry.costTotal ?? 0);
				const quarterBucket = getUtcQuarterHourBucketKey(entry.timestamp);
				const utcQuarterHourToken = utcQuarterHourTokenMap.get(quarterBucket.key) ?? {
					date: quarterBucket.date,
					quarterIndex: quarterBucket.quarterIndex,
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					totalCost: 0
				};
				utcQuarterHourToken.input += entryTokenTotals.input;
				utcQuarterHourToken.output += entryTokenTotals.output;
				utcQuarterHourToken.cacheRead += entryTokenTotals.cacheRead;
				utcQuarterHourToken.cacheWrite += entryTokenTotals.cacheWrite;
				utcQuarterHourToken.totalTokens += entryTokenTotals.totalTokens;
				utcQuarterHourToken.totalCost += entryCost;
				utcQuarterHourTokenMap.set(quarterBucket.key, utcQuarterHourToken);
				const existing = dailyMap.get(dayKey) ?? {
					tokens: 0,
					cost: 0
				};
				dailyMap.set(dayKey, {
					tokens: existing.tokens + entryTokens,
					cost: existing.cost + entryCost
				});
				if (entry.provider || entry.model) {
					const modelKey = `${dayKey}::${entry.provider ?? "unknown"}::${entry.model ?? "unknown"}`;
					const dailyModel = dailyModelUsageMap.get(modelKey) ?? {
						date: dayKey,
						provider: entry.provider,
						model: entry.model,
						tokens: 0,
						cost: 0,
						count: 0
					};
					dailyModel.tokens += entryTokens;
					dailyModel.cost += entryCost;
					dailyModel.count += 1;
					dailyModelUsageMap.set(modelKey, dailyModel);
				}
			}
			if (entry.provider || entry.model) {
				const key = `${entry.provider ?? "unknown"}::${entry.model ?? "unknown"}`;
				const existing = modelUsageMap.get(key) ?? {
					provider: entry.provider,
					model: entry.model,
					count: 0,
					totals: emptyTotals()
				};
				existing.count += 1;
				applyUsageTotals(existing.totals, entry.usage);
				if (entry.costBreakdown?.total !== void 0) applyCostBreakdown(existing.totals, entry.costBreakdown);
				else applyCostTotal(existing.totals, entry.costTotal);
				modelUsageMap.set(key, existing);
			}
		}
	});
	const dailyBreakdown = Array.from(dailyMap.entries()).map(([date, data]) => ({
		date,
		tokens: data.tokens,
		cost: data.cost
	})).toSorted((a, b) => a.date.localeCompare(b.date));
	const dailyMessageCounts = Array.from(dailyMessageMap.values()).toSorted((a, b) => a.date.localeCompare(b.date));
	const utcQuarterHourMessageCounts = Array.from(utcQuarterHourMessageMap.values()).toSorted((a, b) => a.date.localeCompare(b.date) || a.quarterIndex - b.quarterIndex);
	const utcQuarterHourTokenUsage = Array.from(utcQuarterHourTokenMap.values()).toSorted((a, b) => a.date.localeCompare(b.date) || a.quarterIndex - b.quarterIndex);
	const dailyLatency = Array.from(dailyLatencyMap.entries()).map(([date, values]) => {
		const stats = computeLatencyStats(values);
		if (!stats) return null;
		return Object.assign({ date }, stats);
	}).filter((entry) => Boolean(entry)).toSorted((a, b) => a.date.localeCompare(b.date));
	const dailyModelUsage = Array.from(dailyModelUsageMap.values()).toSorted((a, b) => a.date.localeCompare(b.date) || b.cost - a.cost);
	const toolUsage = toolUsageMap.size ? {
		totalCalls: Array.from(toolUsageMap.values()).reduce((sum, count) => sum + count, 0),
		uniqueTools: toolUsageMap.size,
		tools: Array.from(toolUsageMap.entries()).map(([name, count]) => ({
			name,
			count
		})).toSorted((a, b) => b.count - a.count)
	} : void 0;
	const modelUsage = modelUsageMap.size ? Array.from(modelUsageMap.values()).toSorted((a, b) => {
		const costDiff = (b.totals?.totalCost ?? 0) - (a.totals?.totalCost ?? 0);
		if (costDiff !== 0) return costDiff;
		return (b.totals?.totalTokens ?? 0) - (a.totals?.totalTokens ?? 0);
	}) : void 0;
	return {
		sessionId: params.sessionId,
		sessionFile,
		firstActivity,
		lastActivity,
		durationMs: firstActivity !== void 0 && lastActivity !== void 0 ? Math.max(0, lastActivity - firstActivity) : void 0,
		activityDates: Array.from(activityDatesSet).toSorted(),
		dailyBreakdown,
		dailyMessageCounts,
		utcQuarterHourMessageCounts: utcQuarterHourMessageCounts.length ? utcQuarterHourMessageCounts : void 0,
		utcQuarterHourTokenUsage: utcQuarterHourTokenUsage.length ? utcQuarterHourTokenUsage : void 0,
		dailyLatency: dailyLatency.length ? dailyLatency : void 0,
		dailyModelUsage: dailyModelUsage.length ? dailyModelUsage : void 0,
		messageCounts,
		toolUsage,
		modelUsage,
		latency: computeLatencyStats(latencyValues),
		...totals
	};
}
async function loadSessionUsageTimeSeries(params) {
	const sessionFile = resolveExistingUsageSessionFile(params);
	if (!sessionFile || !fs.existsSync(sessionFile)) return null;
	const points = [];
	let cumulativeTokens = 0;
	let cumulativeCost = 0;
	await scanUsageFile({
		filePath: sessionFile,
		config: params.config,
		onEntry: (entry) => {
			const ts = entry.timestamp?.getTime();
			if (!ts) return;
			const { input, output, cacheRead, cacheWrite, totalTokens } = computeUsageTokenTotals(entry.usage);
			const cost = entry.costTotal ?? 0;
			cumulativeTokens += totalTokens;
			cumulativeCost += cost;
			points.push({
				timestamp: ts,
				input,
				output,
				cacheRead,
				cacheWrite,
				totalTokens,
				cost,
				cumulativeTokens,
				cumulativeCost
			});
		}
	});
	const sortedPoints = points.toSorted((a, b) => a.timestamp - b.timestamp);
	if (params.maxPoints !== void 0 && params.maxPoints !== null) {
		if (!Number.isFinite(params.maxPoints) || params.maxPoints <= 0) return {
			sessionId: params.sessionId,
			points: []
		};
	}
	const maxPoints = params.maxPoints ?? 100;
	if (sortedPoints.length > maxPoints) {
		const step = Math.ceil(sortedPoints.length / maxPoints);
		const downsampled = [];
		let downsampledCumulativeTokens = 0;
		let downsampledCumulativeCost = 0;
		for (let i = 0; i < sortedPoints.length; i += step) {
			const bucket = sortedPoints.slice(i, i + step);
			const bucketLast = bucket[bucket.length - 1];
			if (!bucketLast) continue;
			let bucketInput = 0;
			let bucketOutput = 0;
			let bucketCacheRead = 0;
			let bucketCacheWrite = 0;
			let bucketTotalTokens = 0;
			let bucketCost = 0;
			for (const point of bucket) {
				bucketInput += point.input;
				bucketOutput += point.output;
				bucketCacheRead += point.cacheRead;
				bucketCacheWrite += point.cacheWrite;
				bucketTotalTokens += point.totalTokens;
				bucketCost += point.cost;
			}
			downsampledCumulativeTokens += bucketTotalTokens;
			downsampledCumulativeCost += bucketCost;
			downsampled.push({
				timestamp: bucketLast.timestamp,
				input: bucketInput,
				output: bucketOutput,
				cacheRead: bucketCacheRead,
				cacheWrite: bucketCacheWrite,
				totalTokens: bucketTotalTokens,
				cost: bucketCost,
				cumulativeTokens: downsampledCumulativeTokens,
				cumulativeCost: downsampledCumulativeCost
			});
		}
		return {
			sessionId: params.sessionId,
			points: downsampled
		};
	}
	return {
		sessionId: params.sessionId,
		points: sortedPoints
	};
}
async function loadSessionLogs(params) {
	const sessionFile = resolveExistingUsageSessionFile(params);
	if (!sessionFile || !fs.existsSync(sessionFile)) return null;
	const logs = [];
	if (params.limit !== void 0 && params.limit !== null) {
		if (!Number.isFinite(params.limit) || params.limit <= 0) return [];
	}
	const limit = params.limit ?? 50;
	for await (const parsed of readJsonlRecords(sessionFile)) try {
		const message = parsed.message;
		if (!message) continue;
		const role = message.role;
		if (role !== "user" && role !== "assistant" && role !== "tool" && role !== "toolResult") continue;
		const contentParts = [];
		const toolName = normalizeOptionalString(message.toolName ?? message.tool_name ?? message.name ?? message.tool);
		if (role === "tool" || role === "toolResult") {
			contentParts.push(`[Tool: ${toolName ?? "tool"}]`);
			contentParts.push("[Tool Result]");
		}
		const rawContent = message.content;
		if (typeof rawContent === "string") contentParts.push(rawContent);
		else if (Array.isArray(rawContent)) {
			const contentText = rawContent.map((block) => {
				if (typeof block === "string") return block;
				const b = block;
				if (b.type === "text" && typeof b.text === "string") return b.text;
				if (b.type === "tool_use") return `[Tool: ${typeof b.name === "string" ? b.name : "unknown"}]`;
				if (b.type === "tool_result") return `[Tool Result]`;
				return "";
			}).filter(Boolean).join("\n");
			if (contentText) contentParts.push(contentText);
		}
		const rawToolCalls = message.tool_calls ?? message.toolCalls ?? message.function_call ?? message.functionCall;
		const toolCalls = Array.isArray(rawToolCalls) ? rawToolCalls : rawToolCalls ? [rawToolCalls] : [];
		if (toolCalls.length > 0) for (const call of toolCalls) {
			const callObj = call;
			const directName = typeof callObj.name === "string" ? callObj.name : void 0;
			const fn = callObj.function;
			const fnName = typeof fn?.name === "string" ? fn.name : void 0;
			const name = directName ?? fnName ?? "unknown";
			contentParts.push(`[Tool: ${name}]`);
		}
		let content = contentParts.join("\n").trim();
		if (!content) continue;
		content = stripInboundMetadata(content);
		if (role === "user") content = stripMessageIdHints(stripEnvelope(content)).trim();
		if (!content) continue;
		const maxLen = 2e3;
		if (content.length > maxLen) content = content.slice(0, maxLen) + "…";
		let timestamp = 0;
		if (typeof parsed.timestamp === "string") timestamp = new Date(parsed.timestamp).getTime();
		else if (typeof message.timestamp === "number") timestamp = message.timestamp;
		let tokens;
		let cost;
		if (role === "assistant") {
			const usageRaw = message.usage;
			const usage = normalizeUsage(usageRaw);
			if (usage) {
				tokens = usage.total ?? (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
				const breakdown = extractCostBreakdown(usageRaw);
				if (breakdown?.total !== void 0) cost = breakdown.total;
				else cost = estimateUsageCost({
					usage,
					cost: resolveModelCostConfig({
						provider: message.provider,
						model: message.model,
						config: params.config
					})
				});
			}
		}
		logs.push({
			timestamp,
			role,
			content,
			tokens,
			cost
		});
	} catch {}
	const sortedLogs = logs.toSorted((a, b) => a.timestamp - b.timestamp);
	if (sortedLogs.length > limit) return sortedLogs.slice(-limit);
	return sortedLogs;
}
//#endregion
export { loadSessionCostSummaryFromCache as a, resolveExistingUsageSessionFile as c, loadSessionCostSummary as i, loadCostUsageSummary as n, loadSessionLogs as o, loadCostUsageSummaryFromCache as r, loadSessionUsageTimeSeries as s, discoverAllSessions as t };
