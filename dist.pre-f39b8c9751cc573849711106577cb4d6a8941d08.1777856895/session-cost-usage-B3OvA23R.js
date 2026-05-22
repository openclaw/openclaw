import { c as normalizeOptionalString } from "./string-coerce-Bje8XVt9.js";
import { a as isSessionArchiveArtifactName, d as parseParentSessionIdFromCheckpointFileName, f as parseSessionArchiveTimestamp, i as isPrimarySessionTranscriptFileName, l as isUsageCountedSessionTranscriptFileName, n as isCheckpointSessionTranscriptFileName, p as parseUsageCountedSessionIdFromFileName } from "./artifacts-CajEWO03.js";
import { i as resolveSessionFilePath, l as resolveSessionTranscriptsDirForAgent } from "./paths-CJq5T6t4.js";
import { a as resolveModelCostConfig, n as estimateUsageCost } from "./usage-format-ynZM9tuJ.js";
import { t as asFiniteNumber } from "./number-coercion-BKUkfEce.js";
import { o as normalizeUsage } from "./usage-CbNR5ctp.js";
import { _ as stripEnvelope, b as extractToolCallNames, v as stripMessageIdHints, y as countToolResults } from "./session-utils.fs-D59mRZNQ.js";
import { n as stripInboundMetadata } from "./strip-inbound-meta-BDl97B8O.js";
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
async function* readJsonlRecords(filePath) {
	const fileStream = fs.createReadStream(filePath, { encoding: "utf-8" });
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
	for await (const parsed of readJsonlRecords(params.filePath)) {
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
	const files = (await Promise.all(entries.filter((entry) => entry.isFile() && isUsageCountedSessionTranscriptFileName(entry.name) && !isCheckpointSessionTranscriptFileName(entry.name)).map(async (entry) => {
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
		if (isCheckpointSessionTranscriptFileName(entry.name)) {
			const parentId = parseParentSessionIdFromCheckpointFileName(entry.name);
			if (!parentId) continue;
			const existing = discovered.get(parentId);
			if (!existing) discovered.set(parentId, {
				sessionId: parentId,
				sessionFile: filePath,
				mtime: stats.mtimeMs,
				firstUserMessage: void 0
			});
			else if (stats.mtimeMs > existing.mtime) {
				const existingIsPrimary = isPrimarySessionTranscriptFileName(path.basename(existing.sessionFile));
				discovered.set(parentId, {
					...existing,
					sessionFile: existingIsPrimary ? existing.sessionFile : filePath,
					mtime: stats.mtimeMs
				});
			}
			continue;
		}
		const sessionId = parseUsageCountedSessionIdFromFileName(entry.name);
		if (!sessionId) continue;
		const isPrimaryTranscript = isPrimarySessionTranscriptFileName(entry.name);
		let firstUserMessage;
		try {
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
export { loadSessionUsageTimeSeries as a, loadSessionLogs as i, loadCostUsageSummary as n, resolveExistingUsageSessionFile as o, loadSessionCostSummary as r, discoverAllSessions as t };
