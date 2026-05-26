import { t as isJsonObject } from "./protocol-CJecV8AU.js";
//#region extensions/codex/src/app-server/rate-limits.ts
const CODEX_LIMIT_ID = "codex";
const LIMIT_WINDOW_KEYS = ["primary", "secondary"];
const ONE_MINUTE_MS = 6e4;
const ONE_HOUR_MS = 60 * ONE_MINUTE_MS;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;
function formatCodexUsageLimitErrorMessage(params) {
	const message = normalizeText(params.message);
	if (!isCodexUsageLimitError(params.codexErrorInfo, message)) return;
	const nowMs = params.nowMs ?? Date.now();
	const nextReset = selectNextRateLimitReset(params.rateLimits, nowMs);
	const parts = ["You've reached your Codex subscription usage limit."];
	if (nextReset) parts.push(`Next reset ${formatResetTime(nextReset.resetsAtMs, nowMs)}.`);
	else {
		const codexRetryHint = extractCodexRetryHint(message);
		if (codexRetryHint) parts.push(`Codex says to try again ${codexRetryHint}.`);
		else parts.push("Codex did not return a reset time for this limit.");
	}
	parts.push("Run /codex account for current usage details.");
	return parts.join(" ");
}
function shouldRefreshCodexRateLimitsForUsageLimitMessage(message) {
	const text = normalizeText(message);
	return Boolean(text?.includes("You've reached your Codex subscription usage limit.") && !text.includes("Next reset "));
}
function summarizeCodexRateLimits(value, nowMs = Date.now()) {
	const snapshots = collectCodexRateLimitSnapshots(value);
	if (snapshots.length === 0) return;
	return snapshots.slice(0, 4).map((snapshot) => summarizeRateLimitSnapshot(snapshot, nowMs)).join("; ");
}
function summarizeCodexAccountRateLimits(value, nowMs = Date.now()) {
	const summary = summarizeCodexAccountUsage(value, nowMs);
	if (!summary) return;
	if (!summary.blocked) return ["Codex is available."];
	return [summary.blockedUntilText ? `Codex is paused until ${summary.blockedUntilText}.` : "Codex is paused by a usage limit.", summary.blockingReason ? `Your ${summary.blockingReason}.` : "Your Codex usage limit is reached."];
}
function resolveCodexUsageLimitResetAtMs(value, nowMs = Date.now()) {
	return selectBlockingRateLimitReset(value, nowMs)?.resetsAtMs;
}
function summarizeCodexAccountUsage(value, nowMs = Date.now()) {
	const snapshots = collectCodexRateLimitSnapshots(value);
	if (snapshots.length === 0) return;
	const usageSnapshot = snapshots.find(isCodexLimitSnapshot) ?? snapshots[0];
	const blockedSnapshots = snapshots.filter(snapshotHasLimitBlock);
	const blockingSnapshot = blockedSnapshots.find(isCodexLimitSnapshot) ?? blockedSnapshots[0] ?? void 0;
	const blockingReset = blockingSnapshot ? selectSnapshotBlockingReset(blockingSnapshot, nowMs) : void 0;
	const blockingPeriod = formatBlockingLimitPeriod(blockingReset?.windowDurationMins);
	const blockedUntilText = blockingReset ? formatAccountResetTime(blockingReset.resetsAtMs, nowMs) : void 0;
	const blockedResetRelative = blockingReset ? `in ${formatRelativeDuration(blockingReset.resetsAtMs - nowMs)}` : void 0;
	const blockingReason = blockingPeriod ? `${blockingPeriod} Codex usage limit is reached` : blockingSnapshot ? "Codex usage limit is reached" : void 0;
	return {
		usageLine: formatUsageLine(usageSnapshot),
		blocked: Boolean(blockingSnapshot),
		...blockingReset ? { blockedUntilMs: blockingReset.resetsAtMs } : {},
		...blockedUntilText ? { blockedUntilText } : {},
		...blockedResetRelative ? { blockedResetRelative } : {},
		...blockingPeriod ? { blockingPeriod } : {},
		...blockingReason ? { blockingReason } : {}
	};
}
function isCodexUsageLimitError(codexErrorInfo, message) {
	if (codexErrorInfo === "usageLimitExceeded") return true;
	if (typeof codexErrorInfo === "string") {
		if (codexErrorInfo.replace(/[_\s-]/gu, "").toLowerCase() === "usagelimitexceeded") return true;
	}
	return Boolean(message?.toLowerCase().includes("usage limit"));
}
function selectNextRateLimitReset(value, nowMs) {
	const futureWindows = collectCodexRateLimitSnapshots(value).flatMap((snapshot) => LIMIT_WINDOW_KEYS.flatMap((key) => readRateLimitWindow(snapshot, key) ?? [])).filter((window) => window.resetsAtMs > nowMs);
	if (futureWindows.length === 0) return;
	const exhaustedWindows = futureWindows.filter((window) => window.usedPercent !== void 0 && window.usedPercent >= 100);
	return (exhaustedWindows.length > 0 ? exhaustedWindows : futureWindows).toSorted((left, right) => left.resetsAtMs - right.resetsAtMs)[0];
}
function selectBlockingRateLimitReset(value, nowMs) {
	const blockedSnapshots = collectCodexRateLimitSnapshots(value).filter(snapshotHasLimitBlock);
	const blockingSnapshot = blockedSnapshots.find(isCodexLimitSnapshot) ?? blockedSnapshots[0] ?? void 0;
	return blockingSnapshot ? selectSnapshotBlockingReset(blockingSnapshot, nowMs) : void 0;
}
function summarizeRateLimitSnapshot(snapshot, nowMs) {
	const label = formatLimitLabel(snapshot);
	const windows = LIMIT_WINDOW_KEYS.flatMap((key) => {
		const window = readRateLimitWindow(snapshot, key);
		return window ? [formatRateLimitWindow(key, window, nowMs)] : [];
	});
	const reachedType = readString$1(snapshot, "rateLimitReachedType") ?? readString$1(snapshot, "rate_limit_reached_type");
	const suffix = reachedType ? ` (${formatReachedType(reachedType)})` : "";
	return `${label}: ${windows.join(", ") || "available"}${suffix}`;
}
function collectCodexRateLimitSnapshots(value) {
	const snapshots = [];
	collectRateLimitSnapshots(value, snapshots, /* @__PURE__ */ new Set());
	return snapshots;
}
function collectRateLimitSnapshots(value, snapshots, seen) {
	if (Array.isArray(value)) {
		for (const entry of value) collectRateLimitSnapshots(entry, snapshots, seen);
		return;
	}
	if (!isJsonObject(value)) return;
	if (isRateLimitSnapshot(value)) {
		addRateLimitSnapshot(value, snapshots, seen);
		return;
	}
	const byLimitId = value.rateLimitsByLimitId;
	if (isJsonObject(byLimitId)) for (const key of sortedRateLimitKeys(Object.keys(byLimitId))) collectRateLimitSnapshots(byLimitId[key], snapshots, seen);
	const snakeByLimitId = value.rate_limits_by_limit_id;
	if (isJsonObject(snakeByLimitId)) for (const key of sortedRateLimitKeys(Object.keys(snakeByLimitId))) collectRateLimitSnapshots(snakeByLimitId[key], snapshots, seen);
	collectRateLimitSnapshots(value.rateLimits, snapshots, seen);
	collectRateLimitSnapshots(value.rate_limits, snapshots, seen);
	collectRateLimitSnapshots(value.data, snapshots, seen);
	collectRateLimitSnapshots(value.items, snapshots, seen);
}
function sortedRateLimitKeys(keys) {
	return keys.toSorted((left, right) => {
		if (left === CODEX_LIMIT_ID) return -1;
		if (right === CODEX_LIMIT_ID) return 1;
		return left.localeCompare(right);
	});
}
function addRateLimitSnapshot(snapshot, snapshots, seen) {
	const signature = [
		readNullableString(snapshot, "limitId") ?? readNullableString(snapshot, "limit_id") ?? "",
		readNullableString(snapshot, "limitName") ?? readNullableString(snapshot, "limit_name") ?? "",
		formatWindowSignature(snapshot.primary),
		formatWindowSignature(snapshot.secondary)
	].join("|");
	if (seen.has(signature)) return;
	seen.add(signature);
	snapshots.push(snapshot);
}
function isRateLimitSnapshot(value) {
	return isJsonObject(value.primary) || isJsonObject(value.secondary) || value.rateLimitReachedType !== void 0 || value.rate_limit_reached_type !== void 0 || value.limitId !== void 0 || value.limit_id !== void 0 || value.limitName !== void 0 || value.limit_name !== void 0;
}
function readRateLimitWindow(snapshot, key) {
	const window = snapshot[key];
	if (!isJsonObject(window)) return;
	const resetsAt = readNumber(window, "resetsAt") ?? readNumber(window, "resets_at");
	return {
		...typeof resetsAt === "number" && Number.isFinite(resetsAt) && resetsAt > 0 ? { resetsAtMs: resetsAt * 1e3 } : { resetsAtMs: 0 },
		...readOptionalNumberField(window, "usedPercent", "used_percent"),
		...readOptionalNumberField(window, "windowDurationMins", "window_duration_mins", "windowMinutes", "window_minutes")
	};
}
function readOptionalNumberField(record, ...keys) {
	const value = keys.map((key) => readNumber(record, key)).find((entry) => entry !== void 0);
	if (value === void 0) return {};
	return keys.some((key) => key.toLowerCase().includes("window")) ? { windowDurationMins: value } : { usedPercent: value };
}
function formatRateLimitWindow(key, window, nowMs) {
	return `${key} ${formatRateLimitWindowDetails(window, nowMs)}`;
}
function formatRateLimitWindowDetails(window, nowMs) {
	return `${window.usedPercent === void 0 ? "usage unknown" : `${Math.round(window.usedPercent)}%`}${window.resetsAtMs > nowMs ? `, resets ${formatResetTime(window.resetsAtMs, nowMs)}` : ""}`;
}
function formatLimitLabel(snapshot) {
	const label = readNullableString(snapshot, "limitName") ?? readNullableString(snapshot, "limit_name") ?? readNullableString(snapshot, "limitId") ?? readNullableString(snapshot, "limit_id");
	if (!label || label === CODEX_LIMIT_ID) return "Codex";
	return label.replace(/[_-]+/gu, " ").replace(/\s+/gu, " ").trim();
}
function formatReachedType(value) {
	return value.replace(/[_-]+/gu, " ").replace(/\s+/gu, " ").trim();
}
function formatResetTime(resetsAtMs, nowMs) {
	return `in ${formatRelativeDuration(resetsAtMs - nowMs)}, ${formatCalendarResetTime(resetsAtMs, nowMs)}`;
}
function formatAccountResetTime(resetsAtMs, nowMs) {
	return `${formatCalendarResetTime(resetsAtMs, nowMs)} (in ${formatRelativeDuration(resetsAtMs - nowMs)})`;
}
function snapshotHasLimitBlock(snapshot) {
	return Boolean(readString$1(snapshot, "rateLimitReachedType") ?? readString$1(snapshot, "rate_limit_reached_type") ?? readWindowEntries(snapshot).some((entry) => entry.window.usedPercent !== void 0 && entry.window.usedPercent >= 100));
}
function isCodexLimitSnapshot(snapshot) {
	const id = readNullableString(snapshot, "limitId") ?? readNullableString(snapshot, "limit_id");
	return !id || id === CODEX_LIMIT_ID;
}
function selectSnapshotBlockingReset(snapshot, nowMs) {
	const futureWindows = readWindowEntries(snapshot).map((entry) => entry.window).filter((window) => window.resetsAtMs > nowMs);
	const exhaustedWindows = futureWindows.filter((window) => window.usedPercent !== void 0 && window.usedPercent >= 100);
	const candidates = exhaustedWindows.length > 0 ? exhaustedWindows : futureWindows;
	const resetSort = exhaustedWindows.length > 0 ? (left, right) => right.resetsAtMs - left.resetsAtMs : (left, right) => left.resetsAtMs - right.resetsAtMs;
	return candidates.toSorted(resetSort)[0];
}
function readWindowEntries(snapshot) {
	return LIMIT_WINDOW_KEYS.flatMap((key) => {
		const window = readRateLimitWindow(snapshot, key);
		return window ? [{
			key,
			window
		}] : [];
	});
}
function formatBlockingLimitPeriod(minutes) {
	if (minutes === 10080) return "weekly";
	if (minutes === 1440) return "daily";
	if (minutes !== void 0 && minutes > 0 && minutes < 1440) return "short-term";
}
function formatUsageLine(snapshot) {
	const windows = readWindowEntries(snapshot).filter((entry) => entry.window.usedPercent !== void 0).toSorted((left, right) => (right.window.windowDurationMins ?? 0) - (left.window.windowDurationMins ?? 0)).map((entry) => {
		return `${formatUsageWindowLabel(entry.window.windowDurationMins)} ${Math.round(entry.window.usedPercent ?? 0)}%`;
	});
	return windows.length > 0 ? windows.join(" · ") : void 0;
}
function formatUsageWindowLabel(minutes) {
	if (minutes === 10080) return "weekly";
	if (minutes === 1440) return "daily";
	if (minutes !== void 0 && minutes > 0 && minutes < 1440) return "short-term";
	if (minutes !== void 0 && minutes > 0 && minutes % 1440 === 0) return `${minutes / 1440}-day`;
	if (minutes !== void 0 && minutes > 0 && minutes % 60 === 0) return `${minutes / 60}-hour`;
	return "usage";
}
function formatCalendarResetTime(resetsAtMs, nowMs) {
	const resetDate = new Date(resetsAtMs);
	const resetParts = new Intl.DateTimeFormat("en-US", {
		month: "short",
		day: "numeric",
		...resetDate.getFullYear() === new Date(nowMs).getFullYear() ? {} : { year: "numeric" },
		hour: "numeric",
		minute: "2-digit",
		timeZoneName: "short"
	}).formatToParts(resetDate);
	const part = (type) => resetParts.find((entry) => entry.type === type)?.value;
	const dateParts = [
		part("month"),
		part("day"),
		part("year")
	].filter(Boolean);
	return [
		dateParts.length > 1 ? `${dateParts[0]} ${dateParts.slice(1).join(", ")}` : dateParts[0],
		"at",
		[
			[part("hour"), part("minute")].filter(Boolean).join(":"),
			part("dayPeriod"),
			part("timeZoneName")
		].filter(Boolean).join(" ")
	].filter(Boolean).join(" ");
}
function formatRelativeDuration(durationMs) {
	const safeMs = Math.max(1e3, durationMs);
	if (safeMs < ONE_MINUTE_MS) return `${Math.ceil(safeMs / 1e3)} seconds`;
	if (safeMs < ONE_HOUR_MS) {
		const minutes = Math.ceil(safeMs / ONE_MINUTE_MS);
		return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
	}
	if (safeMs < ONE_DAY_MS) {
		const hours = Math.ceil(safeMs / ONE_HOUR_MS);
		return `${hours} ${hours === 1 ? "hour" : "hours"}`;
	}
	const days = Math.ceil(safeMs / ONE_DAY_MS);
	return `${days} ${days === 1 ? "day" : "days"}`;
}
function formatWindowSignature(value) {
	if (!isJsonObject(value)) return "";
	return `${readNumber(value, "usedPercent") ?? readNumber(value, "used_percent") ?? ""}:${readNumber(value, "resetsAt") ?? readNumber(value, "resets_at") ?? ""}`;
}
function extractCodexRetryHint(message) {
	if (!message) return;
	const tryAgainAt = /\btry again\s+(at\s+[^.!?\n]+)(?:[.!?]|$)/iu.exec(message);
	if (tryAgainAt?.[1]) return tryAgainAt[1].trim();
	return /\btry again\s+((?:tomorrow|in\s+[^.!?\n]+)[^.!?\n]*)(?:[.!?]|$)/iu.exec(message)?.[1]?.trim();
}
function readString$1(record, key) {
	const value = record[key];
	return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
function readNullableString(record, key) {
	return readString$1(record, key) ?? void 0;
}
function readNumber(record, key) {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function normalizeText(value) {
	const text = value?.trim();
	return text ? text : void 0;
}
//#endregion
//#region extensions/codex/src/command-formatters.ts
function formatCodexStatus(probes) {
	const lines = [`Codex app-server: ${probes.models.ok || probes.account.ok || probes.limits.ok || probes.mcps.ok || probes.skills.ok ? "connected" : "unavailable"}`];
	if (probes.models.ok) lines.push(`Models: ${probes.models.value.models.map((model) => formatCodexDisplayText(model.id)).slice(0, 8).join(", ") || "none"}`);
	else lines.push(`Models: ${formatCodexDisplayText(probes.models.error)}`);
	lines.push(`Account: ${probes.account.ok ? formatCodexAccountSummary(probes.account.value) : formatCodexDisplayText(probes.account.error)}`);
	lines.push(`Rate limits: ${probes.limits.ok ? formatCodexRateLimitSummary(probes.limits.value) : formatCodexDisplayText(probes.limits.error)}`);
	lines.push(`MCP servers: ${probes.mcps.ok ? summarizeArrayLike(probes.mcps.value) : formatCodexDisplayText(probes.mcps.error)}`);
	lines.push(`Skills: ${probes.skills.ok ? summarizeArrayLike(probes.skills.value) : formatCodexDisplayText(probes.skills.error)}`);
	return lines.join("\n");
}
function formatModels(result) {
	if (result.models.length === 0) return "No Codex app-server models returned.";
	const lines = ["Codex models:", ...result.models.map((model) => `- ${formatCodexDisplayText(model.id)}${model.isDefault ? " (default)" : ""}`)];
	if (result.truncated) lines.push("- More models available; output truncated.");
	return lines.join("\n");
}
function formatThreads(response) {
	const threads = extractArray(response);
	if (threads.length === 0) return "No Codex threads returned.";
	return ["Codex threads:", ...threads.slice(0, 10).map((thread) => {
		const record = isJsonObject(thread) ? thread : {};
		const id = readString(record, "threadId") ?? readString(record, "id") ?? "<unknown>";
		const title = readString(record, "title") ?? readString(record, "name") ?? readString(record, "summary");
		const details = [
			readString(record, "model"),
			readString(record, "cwd"),
			readString(record, "updatedAt") ?? readString(record, "lastUpdatedAt")
		].filter((value) => Boolean(value));
		return `- ${formatCodexDisplayText(id)}${title ? ` - ${formatCodexDisplayText(title)}` : ""}${details.length > 0 ? ` (${details.map(formatCodexDisplayText).join(", ")})` : ""}\n  Resume: ${formatCodexResumeHint(id)}`;
	})].join("\n");
}
function formatAccount(account, limits, authOverview) {
	if (authOverview) return formatAccountAuthOverview(authOverview);
	const formattedLimits = limits.ok ? formatCodexRateLimitDetails(limits.value) : formatCodexDisplayText(limits.error);
	const rateLimitBlock = formattedLimits.startsWith("Codex is ") ? formattedLimits : formattedLimits.includes("\n") ? `Rate limits:\n${formattedLimits}` : `Rate limits: ${formattedLimits}`;
	return [`Account: ${account.ok ? formatCodexAccountSummary(account.value) : formatCodexDisplayText(account.error)}`, rateLimitBlock].join("\n\n");
}
function formatAccountAuthOverview(overview) {
	const lines = [];
	if (overview.currentLine) lines.push(overview.currentLine, "");
	if (overview.subscriptionLabel) {
		lines.push(`Subscription  ${overview.subscriptionLabel}`);
		if (overview.subscriptionUsage) lines.push(`  ${overview.subscriptionUsage}`);
		lines.push("");
	}
	if (overview.rows.length > 0) {
		lines.push(overview.orderTitle);
		for (const [index, row] of overview.rows.entries()) lines.push(`  ${index + 1}. ${row.label}   ${row.kind}   — ${formatAuthRowStatus(row)}`);
	}
	while (lines.at(-1) === "") lines.pop();
	return lines.map(formatCodexAccountLine).join("\n");
}
function formatAuthRowStatus(row) {
	return row.billingNote ? `${row.status} · ${row.billingNote}` : row.status;
}
function formatComputerUseStatus(status) {
	const lines = [`Computer Use: ${status.ready ? "ready" : status.enabled ? "not ready" : "disabled"}`];
	lines.push(`Plugin: ${formatCodexDisplayText(status.pluginName)} (${computerUsePluginState(status)})`);
	lines.push(`MCP server: ${formatCodexDisplayText(status.mcpServerName)}${status.mcpServerAvailable ? ` (${status.tools.length} tools)` : " (unavailable)"}`);
	if (status.marketplaceName) lines.push(`Marketplace: ${formatCodexDisplayText(status.marketplaceName)}`);
	if (status.tools.length > 0) lines.push(`Tools: ${status.tools.slice(0, 8).map(formatCodexDisplayText).join(", ")}`);
	lines.push(formatCodexDisplayText(status.message));
	return lines.join("\n");
}
function computerUsePluginState(status) {
	if (!status.installed) return "not installed";
	return status.pluginEnabled ? "installed" : "installed, disabled";
}
function formatList(response, label) {
	const entries = extractArray(response);
	if (entries.length === 0) return `${label}: none returned.`;
	return [`${label}:`, ...entries.slice(0, 25).map((entry) => {
		const record = isJsonObject(entry) ? entry : {};
		return `- ${formatCodexDisplayText(readString(record, "name") ?? readString(record, "id") ?? JSON.stringify(entry))}`;
	})].join("\n");
}
const CODEX_RESUME_SAFE_THREAD_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
function formatCodexResumeHint(threadId) {
	const safe = formatCodexTextForDisplay(threadId);
	if (!CODEX_RESUME_SAFE_THREAD_ID_PATTERN.test(safe)) return "copy the thread id above and run /codex resume <thread-id>";
	return `/codex resume ${safe}`;
}
function formatCodexDisplayText(value) {
	return escapeCodexChatText(formatCodexTextForDisplay(value));
}
function formatCodexAccountSummary(value) {
	const safe = formatCodexTextForDisplay(summarizeAccount(value));
	return isLikelyEmailAddress(safe) ? escapeCodexChatTextPreservingAt(safe) : escapeCodexChatText(safe);
}
function formatCodexTextForDisplay(value) {
	return sanitizeCodexTextForDisplay(value).trim() || "<unknown>";
}
function sanitizeCodexTextForDisplay(value) {
	let safe = "";
	for (const character of value) {
		const codePoint = character.codePointAt(0);
		safe += codePoint != null && isUnsafeDisplayCodePoint(codePoint) ? "?" : character;
	}
	return safe;
}
function escapeCodexChatText(value) {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("@", "＠").replaceAll("`", "｀").replaceAll("[", "［").replaceAll("]", "］").replaceAll("(", "（").replaceAll(")", "）").replaceAll("*", "∗").replaceAll("_", "＿").replaceAll("~", "～").replaceAll("|", "｜");
}
function escapeCodexChatTextPreservingAt(value) {
	return escapeCodexChatText(value).replaceAll("＠", "@");
}
function formatCodexAccountLine(value) {
	if (value === "") return "";
	const safe = sanitizeCodexTextForDisplay(value).trimEnd();
	if (!safe.trim()) return "";
	const emailPattern = /[^\s@<>()[\]`]+@[^\s@<>()[\]`]+\.[^\s@<>()[\]`]+/gu;
	let formatted = "";
	let lastIndex = 0;
	for (const match of safe.matchAll(emailPattern)) {
		const index = match.index ?? 0;
		formatted += escapeCodexChatText(safe.slice(lastIndex, index));
		formatted += escapeCodexChatTextPreservingAt(match[0]);
		lastIndex = index + match[0].length;
	}
	formatted += escapeCodexChatText(safe.slice(lastIndex));
	return formatted;
}
function isLikelyEmailAddress(value) {
	return /^[^\s@<>()[\]`]+@[^\s@<>()[\]`]+\.[^\s@<>()[\]`]+$/.test(value);
}
function isUnsafeDisplayCodePoint(codePoint) {
	return codePoint <= 31 || codePoint >= 127 && codePoint <= 159 || codePoint === 173 || codePoint === 1564 || codePoint === 6158 || codePoint >= 8203 && codePoint <= 8207 || codePoint >= 8234 && codePoint <= 8238 || codePoint >= 8288 && codePoint <= 8303 || codePoint === 65279 || codePoint >= 65529 && codePoint <= 65531 || codePoint >= 917504 && codePoint <= 917631;
}
function buildHelp() {
	return [
		"Codex commands:",
		"- /codex status",
		"- /codex models",
		"- /codex threads [filter]",
		"- /codex resume <thread-id>",
		"- /codex bind [thread-id] [--cwd <path>] [--model <model>] [--provider <provider>]",
		"- /codex binding",
		"- /codex stop",
		"- /codex steer <message>",
		"- /codex model [model]",
		"- /codex fast [on|off|status]",
		"- /codex permissions [default|yolo|status]",
		"- /codex detach",
		"- /codex compact",
		"- /codex review",
		"- /codex diagnostics [note]",
		"- /codex computer-use [status|install]",
		"- /codex account",
		"- /codex mcp",
		"- /codex skills"
	].join("\n");
}
function summarizeAccount(value) {
	if (!isJsonObject(value)) return "unavailable";
	const account = isJsonObject(value.account) ? value.account : value;
	if (readString(account, "type") === "amazonBedrock") return "Amazon Bedrock";
	return readString(account, "email") ?? readString(account, "accountEmail") ?? readString(account, "planType") ?? readString(account, "id") ?? "available";
}
function summarizeArrayLike(value) {
	const entries = extractArray(value);
	if (entries.length === 0) return "none returned";
	return `${entries.length}`;
}
function formatCodexRateLimitSummary(value) {
	return formatCodexDisplayText(summarizeCodexRateLimits(value) ?? summarizeRateLimits(value));
}
function formatCodexRateLimitDetails(value) {
	const lines = summarizeCodexAccountRateLimits(value);
	if (!lines) return formatCodexDisplayText(summarizeRateLimits(value));
	return lines.map(formatCodexDisplayText).join("\n");
}
function summarizeRateLimits(value) {
	const entries = extractArray(value);
	if (entries.length > 0) return `${entries.length}`;
	if (!isJsonObject(value)) return "none returned";
	const keyed = value.rateLimitsByLimitId;
	if (isJsonObject(keyed)) {
		const count = Object.values(keyed).filter(isMeaningfulRateLimitSnapshot).length;
		if (count > 0) return `${count}`;
	}
	return isMeaningfulRateLimitSnapshot(value.rateLimits) ? "1" : "none returned";
}
function isMeaningfulRateLimitSnapshot(value) {
	return isJsonObject(value) && Object.values(value).some((entry) => entry != null);
}
function extractArray(value) {
	if (Array.isArray(value)) return value;
	if (!isJsonObject(value)) return [];
	for (const key of [
		"data",
		"items",
		"threads",
		"models",
		"skills",
		"servers",
		"rateLimits"
	]) {
		const child = value[key];
		if (Array.isArray(child)) return child;
	}
	return [];
}
function readString(record, key) {
	const value = record[key];
	return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
//#endregion
export { formatComputerUseStatus as a, formatThreads as c, resolveCodexUsageLimitResetAtMs as d, shouldRefreshCodexRateLimitsForUsageLimitMessage as f, formatCodexStatus as i, readString as l, formatAccount as n, formatList as o, summarizeCodexAccountUsage as p, formatCodexDisplayText as r, formatModels as s, buildHelp as t, formatCodexUsageLimitErrorMessage as u };
