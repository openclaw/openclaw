import { l as init_utils, u as isRecord } from "./utils-CMc9mmF8.js";
import { Kn as PROVIDER_LABELS, qn as clampPercent } from "./auth-profiles-B70DPAVa.js";
import { n as fetchJson, r as parseFiniteNumber, t as buildUsageHttpErrorSnapshot } from "./provider-usage.fetch.shared-QRsQTGuu.js";
//#region src/infra/provider-usage.fetch.claude.ts
function buildClaudeUsageWindows(data) {
	const windows = [];
	if (data.five_hour?.utilization !== void 0) windows.push({
		label: "5h",
		usedPercent: clampPercent(data.five_hour.utilization),
		resetAt: data.five_hour.resets_at ? new Date(data.five_hour.resets_at).getTime() : void 0
	});
	if (data.seven_day?.utilization !== void 0) windows.push({
		label: "Week",
		usedPercent: clampPercent(data.seven_day.utilization),
		resetAt: data.seven_day.resets_at ? new Date(data.seven_day.resets_at).getTime() : void 0
	});
	const modelWindow = data.seven_day_sonnet || data.seven_day_opus;
	if (modelWindow?.utilization !== void 0) windows.push({
		label: data.seven_day_sonnet ? "Sonnet" : "Opus",
		usedPercent: clampPercent(modelWindow.utilization)
	});
	return windows;
}
function resolveClaudeWebSessionKey() {
	const direct = process.env.CLAUDE_AI_SESSION_KEY?.trim() ?? process.env.CLAUDE_WEB_SESSION_KEY?.trim();
	if (direct?.startsWith("sk-ant-")) return direct;
	const cookieHeader = process.env.CLAUDE_WEB_COOKIE?.trim();
	if (!cookieHeader) return;
	const value = cookieHeader.replace(/^cookie:\s*/i, "").match(/(?:^|;\s*)sessionKey=([^;\s]+)/i)?.[1]?.trim();
	return value?.startsWith("sk-ant-") ? value : void 0;
}
async function fetchClaudeWebUsage(sessionKey, timeoutMs, fetchFn) {
	const headers = {
		Cookie: `sessionKey=${sessionKey}`,
		Accept: "application/json"
	};
	const orgRes = await fetchJson("https://claude.ai/api/organizations", { headers }, timeoutMs, fetchFn);
	if (!orgRes.ok) return null;
	const orgId = (await orgRes.json())?.[0]?.uuid?.trim();
	if (!orgId) return null;
	const usageRes = await fetchJson(`https://claude.ai/api/organizations/${orgId}/usage`, { headers }, timeoutMs, fetchFn);
	if (!usageRes.ok) return null;
	const windows = buildClaudeUsageWindows(await usageRes.json());
	if (windows.length === 0) return null;
	return {
		provider: "anthropic",
		displayName: PROVIDER_LABELS.anthropic,
		windows
	};
}
async function fetchClaudeUsage(token, timeoutMs, fetchFn) {
	const res = await fetchJson("https://api.anthropic.com/api/oauth/usage", { headers: {
		Authorization: `Bearer ${token}`,
		"User-Agent": "openclaw",
		Accept: "application/json",
		"anthropic-version": "2023-06-01",
		"anthropic-beta": "oauth-2025-04-20"
	} }, timeoutMs, fetchFn);
	if (!res.ok) {
		let message;
		try {
			const raw = (await res.json())?.error?.message;
			if (typeof raw === "string" && raw.trim()) message = raw.trim();
		} catch {}
		if (res.status === 403 && message?.includes("scope requirement user:profile")) {
			const sessionKey = resolveClaudeWebSessionKey();
			if (sessionKey) {
				const web = await fetchClaudeWebUsage(sessionKey, timeoutMs, fetchFn);
				if (web) return web;
			}
		}
		return buildUsageHttpErrorSnapshot({
			provider: "anthropic",
			status: res.status,
			message
		});
	}
	const windows = buildClaudeUsageWindows(await res.json());
	return {
		provider: "anthropic",
		displayName: PROVIDER_LABELS.anthropic,
		windows
	};
}
//#endregion
//#region src/infra/provider-usage.fetch.codex.ts
const WEEKLY_RESET_GAP_SECONDS = 4320 * 60;
function resolveSecondaryWindowLabel(params) {
	if (params.windowHours >= 168) return "Week";
	if (params.windowHours < 24) return `${params.windowHours}h`;
	if (typeof params.secondaryResetAt === "number" && typeof params.primaryResetAt === "number" && params.secondaryResetAt - params.primaryResetAt >= WEEKLY_RESET_GAP_SECONDS) return "Week";
	return "Day";
}
async function fetchCodexUsage(token, accountId, timeoutMs, fetchFn) {
	const headers = {
		Authorization: `Bearer ${token}`,
		"User-Agent": "CodexBar",
		Accept: "application/json"
	};
	if (accountId) headers["ChatGPT-Account-Id"] = accountId;
	const res = await fetchJson("https://chatgpt.com/backend-api/wham/usage", {
		method: "GET",
		headers
	}, timeoutMs, fetchFn);
	if (!res.ok) return buildUsageHttpErrorSnapshot({
		provider: "openai-codex",
		status: res.status,
		tokenExpiredStatuses: [401, 403]
	});
	const data = await res.json();
	const windows = [];
	if (data.rate_limit?.primary_window) {
		const pw = data.rate_limit.primary_window;
		const windowHours = Math.round((pw.limit_window_seconds || 10800) / 3600);
		windows.push({
			label: `${windowHours}h`,
			usedPercent: clampPercent(pw.used_percent || 0),
			resetAt: pw.reset_at ? pw.reset_at * 1e3 : void 0
		});
	}
	if (data.rate_limit?.secondary_window) {
		const sw = data.rate_limit.secondary_window;
		const label = resolveSecondaryWindowLabel({
			windowHours: Math.round((sw.limit_window_seconds || 86400) / 3600),
			primaryResetAt: data.rate_limit?.primary_window?.reset_at,
			secondaryResetAt: sw.reset_at
		});
		windows.push({
			label,
			usedPercent: clampPercent(sw.used_percent || 0),
			resetAt: sw.reset_at ? sw.reset_at * 1e3 : void 0
		});
	}
	let plan = data.plan_type;
	if (data.credits?.balance !== void 0 && data.credits.balance !== null) {
		const balance = typeof data.credits.balance === "number" ? data.credits.balance : parseFloat(data.credits.balance) || 0;
		plan = plan ? `${plan} ($${balance.toFixed(2)})` : `$${balance.toFixed(2)}`;
	}
	return {
		provider: "openai-codex",
		displayName: PROVIDER_LABELS["openai-codex"],
		windows,
		plan
	};
}
//#endregion
//#region src/infra/provider-usage.fetch.gemini.ts
async function fetchGeminiUsage(token, timeoutMs, fetchFn, provider) {
	const res = await fetchJson("https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json"
		},
		body: "{}"
	}, timeoutMs, fetchFn);
	if (!res.ok) return buildUsageHttpErrorSnapshot({
		provider,
		status: res.status
	});
	const data = await res.json();
	const quotas = {};
	for (const bucket of data.buckets || []) {
		const model = bucket.modelId || "unknown";
		const frac = bucket.remainingFraction ?? 1;
		if (!quotas[model] || frac < quotas[model]) quotas[model] = frac;
	}
	const windows = [];
	let proMin = 1;
	let flashMin = 1;
	let hasPro = false;
	let hasFlash = false;
	for (const [model, frac] of Object.entries(quotas)) {
		const lower = model.toLowerCase();
		if (lower.includes("pro")) {
			hasPro = true;
			if (frac < proMin) proMin = frac;
		}
		if (lower.includes("flash")) {
			hasFlash = true;
			if (frac < flashMin) flashMin = frac;
		}
	}
	if (hasPro) windows.push({
		label: "Pro",
		usedPercent: clampPercent((1 - proMin) * 100)
	});
	if (hasFlash) windows.push({
		label: "Flash",
		usedPercent: clampPercent((1 - flashMin) * 100)
	});
	return {
		provider,
		displayName: PROVIDER_LABELS[provider],
		windows
	};
}
//#endregion
//#region src/infra/provider-usage.fetch.minimax.ts
init_utils();
const RESET_KEYS = [
	"reset_at",
	"resetAt",
	"reset_time",
	"resetTime",
	"next_reset_at",
	"nextResetAt",
	"next_reset_time",
	"nextResetTime",
	"expires_at",
	"expiresAt",
	"expire_at",
	"expireAt",
	"end_time",
	"endTime",
	"window_end",
	"windowEnd"
];
const PERCENT_KEYS = [
	"used_percent",
	"usedPercent",
	"usage_percent",
	"usagePercent",
	"used_rate",
	"usage_rate",
	"used_ratio",
	"usage_ratio",
	"usedRatio",
	"usageRatio"
];
const USED_KEYS = [
	"used",
	"usage",
	"used_amount",
	"usedAmount",
	"used_tokens",
	"usedTokens",
	"used_quota",
	"usedQuota",
	"used_times",
	"usedTimes",
	"prompt_used",
	"promptUsed",
	"used_prompt",
	"usedPrompt",
	"prompts_used",
	"promptsUsed",
	"current_interval_usage_count",
	"currentIntervalUsageCount",
	"consumed"
];
const TOTAL_KEYS = [
	"total",
	"total_amount",
	"totalAmount",
	"total_tokens",
	"totalTokens",
	"total_quota",
	"totalQuota",
	"total_times",
	"totalTimes",
	"prompt_total",
	"promptTotal",
	"total_prompt",
	"totalPrompt",
	"prompt_limit",
	"promptLimit",
	"limit_prompt",
	"limitPrompt",
	"prompts_total",
	"promptsTotal",
	"total_prompts",
	"totalPrompts",
	"current_interval_total_count",
	"currentIntervalTotalCount",
	"limit",
	"quota",
	"quota_limit",
	"quotaLimit",
	"max"
];
const REMAINING_KEYS = [
	"remain",
	"remaining",
	"remain_amount",
	"remainingAmount",
	"remaining_amount",
	"remain_tokens",
	"remainingTokens",
	"remaining_tokens",
	"remain_quota",
	"remainingQuota",
	"remaining_quota",
	"remain_times",
	"remainingTimes",
	"remaining_times",
	"prompt_remain",
	"promptRemain",
	"remain_prompt",
	"remainPrompt",
	"prompt_remaining",
	"promptRemaining",
	"remaining_prompt",
	"remainingPrompt",
	"prompts_remaining",
	"promptsRemaining",
	"prompt_left",
	"promptLeft",
	"prompts_left",
	"promptsLeft",
	"left"
];
const PLAN_KEYS = [
	"plan",
	"plan_name",
	"planName",
	"product",
	"tier"
];
const WINDOW_HOUR_KEYS = [
	"window_hours",
	"windowHours",
	"duration_hours",
	"durationHours",
	"hours"
];
const WINDOW_MINUTE_KEYS = [
	"window_minutes",
	"windowMinutes",
	"duration_minutes",
	"durationMinutes",
	"minutes"
];
function pickNumber(record, keys) {
	for (const key of keys) {
		const parsed = parseFiniteNumber(record[key]);
		if (parsed !== void 0) return parsed;
	}
}
function pickString(record, keys) {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
}
function parseEpoch(value) {
	if (typeof value === "number" && Number.isFinite(value)) {
		if (value < 0xe8d4a51000) return Math.floor(value * 1e3);
		return Math.floor(value);
	}
	if (typeof value === "string" && value.trim()) {
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) return parsed;
	}
}
function hasAny(record, keys) {
	return keys.some((key) => key in record);
}
function scoreUsageRecord(record) {
	let score = 0;
	if (hasAny(record, PERCENT_KEYS)) score += 4;
	if (hasAny(record, TOTAL_KEYS)) score += 3;
	if (hasAny(record, USED_KEYS) || hasAny(record, REMAINING_KEYS)) score += 2;
	if (hasAny(record, RESET_KEYS)) score += 1;
	if (hasAny(record, PLAN_KEYS)) score += 1;
	return score;
}
function collectUsageCandidates(root) {
	const MAX_SCAN_DEPTH = 4;
	const MAX_SCAN_NODES = 60;
	const queue = [{
		value: root,
		depth: 0
	}];
	const seen = /* @__PURE__ */ new Set();
	const candidates = [];
	let scanned = 0;
	while (queue.length && scanned < MAX_SCAN_NODES) {
		const next = queue.shift();
		scanned += 1;
		const { value, depth } = next;
		if (isRecord(value)) {
			if (seen.has(value)) continue;
			seen.add(value);
			const score = scoreUsageRecord(value);
			if (score > 0) candidates.push({
				record: value,
				score,
				depth
			});
			if (depth < MAX_SCAN_DEPTH) {
				for (const nested of Object.values(value)) if (isRecord(nested) || Array.isArray(nested)) queue.push({
					value: nested,
					depth: depth + 1
				});
			}
			continue;
		}
		if (Array.isArray(value) && depth < MAX_SCAN_DEPTH) {
			for (const nested of value) if (isRecord(nested) || Array.isArray(nested)) queue.push({
				value: nested,
				depth: depth + 1
			});
		}
	}
	candidates.sort((a, b) => b.score - a.score || a.depth - b.depth);
	return candidates.map((candidate) => candidate.record);
}
function deriveWindowLabel(payload) {
	const hours = pickNumber(payload, WINDOW_HOUR_KEYS);
	if (hours && Number.isFinite(hours)) return `${hours}h`;
	const minutes = pickNumber(payload, WINDOW_MINUTE_KEYS);
	if (minutes && Number.isFinite(minutes)) return `${minutes}m`;
	return "5h";
}
function deriveUsedPercent(payload) {
	const total = pickNumber(payload, TOTAL_KEYS);
	let used = pickNumber(payload, USED_KEYS);
	const remaining = pickNumber(payload, REMAINING_KEYS);
	if (used === void 0 && remaining !== void 0 && total !== void 0) used = total - remaining;
	const fromCounts = total && total > 0 && used !== void 0 && Number.isFinite(used) ? clampPercent(used / total * 100) : null;
	const percentRaw = pickNumber(payload, PERCENT_KEYS);
	if (percentRaw !== void 0) {
		const normalized = clampPercent(percentRaw <= 1 ? percentRaw * 100 : percentRaw);
		if (fromCounts !== null) return fromCounts;
		return normalized;
	}
	return fromCounts;
}
async function fetchMinimaxUsage(apiKey, timeoutMs, fetchFn) {
	const res = await fetchJson("https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains", {
		method: "GET",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
			"MM-API-Source": "OpenClaw"
		}
	}, timeoutMs, fetchFn);
	if (!res.ok) return buildUsageHttpErrorSnapshot({
		provider: "minimax",
		status: res.status
	});
	const data = await res.json().catch(() => null);
	if (!isRecord(data)) return {
		provider: "minimax",
		displayName: PROVIDER_LABELS.minimax,
		windows: [],
		error: "Invalid JSON"
	};
	const baseResp = isRecord(data.base_resp) ? data.base_resp : void 0;
	if (baseResp && typeof baseResp.status_code === "number" && baseResp.status_code !== 0) return {
		provider: "minimax",
		displayName: PROVIDER_LABELS.minimax,
		windows: [],
		error: baseResp.status_msg?.trim() || "API error"
	};
	const payload = isRecord(data.data) ? data.data : data;
	const candidates = collectUsageCandidates(payload);
	let usageRecord = payload;
	let usedPercent = null;
	for (const candidate of candidates) {
		const candidatePercent = deriveUsedPercent(candidate);
		if (candidatePercent !== null) {
			usageRecord = candidate;
			usedPercent = candidatePercent;
			break;
		}
	}
	if (usedPercent === null) usedPercent = deriveUsedPercent(payload);
	if (usedPercent === null) return {
		provider: "minimax",
		displayName: PROVIDER_LABELS.minimax,
		windows: [],
		error: "Unsupported response shape"
	};
	const resetAt = parseEpoch(pickString(usageRecord, RESET_KEYS)) ?? parseEpoch(pickNumber(usageRecord, RESET_KEYS)) ?? parseEpoch(pickString(payload, RESET_KEYS)) ?? parseEpoch(pickNumber(payload, RESET_KEYS));
	const windows = [{
		label: deriveWindowLabel(usageRecord),
		usedPercent,
		resetAt
	}];
	return {
		provider: "minimax",
		displayName: PROVIDER_LABELS.minimax,
		windows,
		plan: pickString(usageRecord, PLAN_KEYS) ?? pickString(payload, PLAN_KEYS)
	};
}
//#endregion
//#region src/infra/provider-usage.fetch.zai.ts
async function fetchZaiUsage(apiKey, timeoutMs, fetchFn) {
	const res = await fetchJson("https://api.z.ai/api/monitor/usage/quota/limit", {
		method: "GET",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			Accept: "application/json"
		}
	}, timeoutMs, fetchFn);
	if (!res.ok) return buildUsageHttpErrorSnapshot({
		provider: "zai",
		status: res.status
	});
	const data = await res.json();
	if (!data.success || data.code !== 200) {
		const errorMessage = typeof data.msg === "string" ? data.msg.trim() : "";
		return {
			provider: "zai",
			displayName: PROVIDER_LABELS.zai,
			windows: [],
			error: errorMessage || "API error"
		};
	}
	const windows = [];
	const limits = data.data?.limits || [];
	for (const limit of limits) {
		const percent = clampPercent(limit.percentage || 0);
		const nextReset = limit.nextResetTime ? new Date(limit.nextResetTime).getTime() : void 0;
		let windowLabel = "Limit";
		if (limit.unit === 1) windowLabel = `${limit.number}d`;
		else if (limit.unit === 3) windowLabel = `${limit.number}h`;
		else if (limit.unit === 5) windowLabel = `${limit.number}m`;
		if (limit.type === "TOKENS_LIMIT") windows.push({
			label: `Tokens (${windowLabel})`,
			usedPercent: percent,
			resetAt: nextReset
		});
		else if (limit.type === "TIME_LIMIT") windows.push({
			label: "Monthly",
			usedPercent: percent,
			resetAt: nextReset
		});
	}
	const planName = data.data?.planName || data.data?.plan || void 0;
	return {
		provider: "zai",
		displayName: PROVIDER_LABELS.zai,
		windows,
		plan: planName
	};
}
//#endregion
export { fetchClaudeUsage as a, fetchCodexUsage as i, fetchMinimaxUsage as n, fetchGeminiUsage as r, fetchZaiUsage as t };
