import { d as resolveAgentIdFromSessionKey } from "./session-key-Bte0mmcq.js";
import { i as getRuntimeConfig } from "./io-DoswVvYe.js";
import "./config-B6Oplu5W.js";
import "./message-channel-core-BoUoCGOD.js";
import "./message-channel-CYCKkVrh.js";
import { r as annotateInterSessionPromptText } from "./input-provenance-CmqYxlZ2.js";
import { r as callGateway } from "./call-t1U2G3yY.js";
import { u as resolveStorePath } from "./paths-Bg3PO6Gj.js";
import { i as readSessionEntry } from "./store-load-z4thf6ld.js";
import "./sessions-CQHHcgC_.js";
import { n as extractTextFromChatContent } from "./chat-content-BNTcXm1Z.js";
import "./runs-DrbsiywK.js";
import { a as isSilentReplyText, n as SILENT_REPLY_TOKEN, t as HEARTBEAT_TOKEN } from "./tokens-CFv3Qu_v.js";
import { c as retireSessionMcpRuntimeForSessionKey } from "./pi-bundle-mcp-runtime-CwBDIKIq.js";
import "./pi-bundle-mcp-tools-_xKQdIka.js";
import { n as sanitizeTextContent, t as extractAssistantText } from "./chat-history-text-BaMeG8tt.js";
import { n as wrapPromptDataBlock } from "./sanitize-for-prompt-ByaJGDhT.js";
import "./server-plugins-Dzx4kGwz.js";
import { i as resolveNestedAgentLaneForSession } from "./lanes-ReZ09_e4.js";
import { a as waitForAgentRunAndReadUpdatedAssistantReply, l as formatBlockedLivenessError, n as readLatestAssistantReply, u as isBlockedLivenessState } from "./run-wait-BlZoP48F.js";
import crypto from "node:crypto";
//#region src/agents/tools/sessions-send-tokens.ts
const ANNOUNCE_SKIP_TOKEN = "ANNOUNCE_SKIP";
const REPLY_SKIP_TOKEN = "REPLY_SKIP";
const NON_DELIVERABLE_REPLY_TOKENS = [
	ANNOUNCE_SKIP_TOKEN,
	REPLY_SKIP_TOKEN,
	SILENT_REPLY_TOKEN,
	HEARTBEAT_TOKEN
];
function isAnnounceSkip(text) {
	return (text ?? "").trim() === ANNOUNCE_SKIP_TOKEN;
}
function isReplySkip(text) {
	return (text ?? "").trim() === REPLY_SKIP_TOKEN;
}
function isNonDeliverableSessionsReply(text) {
	return NON_DELIVERABLE_REPLY_TOKENS.some((token) => isSilentReplyText(text, token));
}
let agentStepDeps = {
	agentCommandFromIngress: (async (...args) => {
		const { agentCommandFromIngress } = await import("./agent-CsexaNYK.js");
		return await agentCommandFromIngress(...args);
	}),
	callGateway
};
function extractAgentCommandReply(result) {
	const payloads = result?.payloads;
	if (!Array.isArray(payloads)) return;
	const texts = payloads.map((payload) => payload && typeof payload === "object" && typeof payload.text === "string" ? payload.text : "").filter((text) => text.trim().length > 0);
	return texts.length > 0 ? texts.join("\n\n") : void 0;
}
async function runAgentStep(params) {
	const stepIdem = crypto.randomUUID();
	const inputProvenance = {
		kind: "inter_session",
		sourceSessionKey: params.sourceSessionKey,
		sourceChannel: params.sourceChannel,
		sourceTool: params.sourceTool ?? "sessions_send"
	};
	const message = annotateInterSessionPromptText(params.message, inputProvenance);
	const lane = params.lane ?? resolveNestedAgentLaneForSession(params.sessionKey);
	const channel = params.channel ?? "webchat";
	if (params.transcriptMessage !== void 0) {
		const result = await agentStepDeps.agentCommandFromIngress({
			message,
			transcriptMessage: params.transcriptMessage,
			sessionKey: params.sessionKey,
			deliver: false,
			channel,
			lane,
			runId: stepIdem,
			extraSystemPrompt: params.extraSystemPrompt,
			inputProvenance,
			allowModelOverride: false
		});
		await retireSessionMcpRuntimeForSessionKey({
			sessionKey: params.sessionKey,
			reason: "nested-agent-step-complete"
		});
		return extractAgentCommandReply(result);
	}
	const response = await agentStepDeps.callGateway({
		method: "agent",
		params: {
			message,
			sessionKey: params.sessionKey,
			idempotencyKey: stepIdem,
			deliver: false,
			channel,
			lane,
			extraSystemPrompt: params.extraSystemPrompt,
			inputProvenance
		},
		timeoutMs: 1e4
	});
	const result = await waitForAgentRunAndReadUpdatedAssistantReply({
		runId: (typeof response?.runId === "string" && response.runId ? response.runId : "") || stepIdem,
		sessionKey: params.sessionKey,
		timeoutMs: Math.min(params.timeoutMs, 6e4)
	});
	if (result.status === "ok" || result.status === "error") await retireSessionMcpRuntimeForSessionKey({
		sessionKey: params.sessionKey,
		reason: "nested-agent-step-complete"
	});
	if (result.status !== "ok") return;
	return result.replyText;
}
//#endregion
//#region src/agents/subagent-announce-capture.ts
async function readLatestSubagentOutputWithRetryUsing(params) {
	const maxWaitMs = Math.max(0, Math.min(params.maxWaitMs, 15e3));
	let waitedMs = 0;
	let result;
	while (waitedMs < maxWaitMs) {
		result = await params.readSubagentOutput(params.sessionKey, params.outcome);
		if (result?.trim()) return result;
		const remainingMs = maxWaitMs - waitedMs;
		if (remainingMs <= 0) break;
		const sleepMs = Math.min(params.retryIntervalMs, remainingMs);
		await new Promise((resolve) => setTimeout(resolve, sleepMs));
		waitedMs += sleepMs;
	}
	return result;
}
async function captureSubagentCompletionReplyUsing(params) {
	const immediate = await params.readSubagentOutput(params.sessionKey);
	if (immediate?.trim()) return immediate;
	if (params.waitForReply === false) return;
	return await readLatestSubagentOutputWithRetryUsing({
		sessionKey: params.sessionKey,
		maxWaitMs: params.maxWaitMs,
		retryIntervalMs: params.retryIntervalMs,
		readSubagentOutput: params.readSubagentOutput
	});
}
//#endregion
//#region src/agents/subagent-yield-output.ts
function asRecord(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function readToolName(value) {
	const record = asRecord(value);
	if (!record) return;
	for (const key of [
		"name",
		"toolName",
		"tool_name",
		"functionName",
		"function_name"
	]) {
		const candidate = record[key];
		if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
	}
}
function isToolCallBlock(value) {
	const record = asRecord(value);
	if (!record) return false;
	return record.type === "toolCall" || record.type === "tool_use" || record.type === "toolUse" || record.type === "functionCall" || record.type === "function_call";
}
function assistantCallsSessionsYield(message) {
	const record = asRecord(message);
	if (!record || record.role !== "assistant" || !Array.isArray(record.content)) return false;
	return record.content.some((block) => isToolCallBlock(block) && readToolName(block) === "sessions_yield");
}
function parseJsonObject(text) {
	const trimmed = text.trim();
	if (!trimmed.startsWith("{")) return;
	try {
		return asRecord(JSON.parse(trimmed));
	} catch {
		return;
	}
}
function readStructuredToolPayload(content) {
	const record = asRecord(content);
	if (record) return record;
	if (typeof content === "string") return parseJsonObject(content);
	if (!Array.isArray(content)) return;
	for (const block of content) {
		const blockRecord = asRecord(block);
		if (!blockRecord) continue;
		const text = blockRecord.text;
		if (typeof text !== "string") continue;
		const parsed = parseJsonObject(text);
		if (parsed) return parsed;
	}
}
function isSessionsYieldToolResult(message, previousAssistantCalledYield) {
	const record = asRecord(message);
	if (!record || record.role !== "toolResult" && record.role !== "tool") return false;
	if (readToolName(record) === "sessions_yield") return true;
	if (!previousAssistantCalledYield) return false;
	if (asRecord(record.details)?.status === "yielded") return true;
	return readStructuredToolPayload(record.content)?.status === "yielded";
}
//#endregion
//#region src/agents/subagent-announce-output.ts
const FAST_TEST_RETRY_INTERVAL_MS = 8;
let subagentAnnounceOutputDeps = {
	callGateway,
	getRuntimeConfig,
	readLatestAssistantReply
};
function isFastTestMode() {
	return process.env.OPENCLAW_TEST_FAST === "1";
}
function readFiniteNumber(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function withSubagentOutcomeTiming(outcome, timing) {
	const startedAt = readFiniteNumber(timing.startedAt) ?? readFiniteNumber(outcome.startedAt);
	const endedAt = readFiniteNumber(timing.endedAt) ?? readFiniteNumber(outcome.endedAt);
	const nextTiming = {};
	if (typeof startedAt === "number") nextTiming.startedAt = startedAt;
	if (typeof endedAt === "number") nextTiming.endedAt = endedAt;
	if (typeof startedAt === "number" && typeof endedAt === "number") nextTiming.elapsedMs = Math.max(0, endedAt - startedAt);
	return {
		...outcome,
		...nextTiming
	};
}
function extractToolResultText(content) {
	if (typeof content === "string") return sanitizeTextContent(content);
	if (content && typeof content === "object" && !Array.isArray(content)) {
		const obj = content;
		if (typeof obj.text === "string") return sanitizeTextContent(obj.text);
		if (typeof obj.output === "string") return sanitizeTextContent(obj.output);
		if (typeof obj.content === "string") return sanitizeTextContent(obj.content);
		if (typeof obj.result === "string") return sanitizeTextContent(obj.result);
		if (typeof obj.error === "string") return sanitizeTextContent(obj.error);
		if (typeof obj.summary === "string") return sanitizeTextContent(obj.summary);
	}
	if (!Array.isArray(content)) return "";
	return extractTextFromChatContent(content, {
		sanitizeText: sanitizeTextContent,
		normalizeText: (text) => text,
		joinWith: "\n"
	})?.trim() ?? "";
}
function extractInlineTextContent(content) {
	if (!Array.isArray(content)) return "";
	return extractTextFromChatContent(content, {
		sanitizeText: sanitizeTextContent,
		normalizeText: (text) => text.trim(),
		joinWith: ""
	}) ?? "";
}
function extractSubagentOutputText(message) {
	if (!message || typeof message !== "object") return "";
	const role = message.role;
	const content = message.content;
	if (role === "assistant") {
		if (typeof content === "string") return sanitizeTextContent(content);
		return extractAssistantText(message) ?? "";
	}
	if (role === "toolResult" || role === "tool") return extractToolResultText(message.content);
	if (role == null) {
		if (typeof content === "string") return sanitizeTextContent(content);
		if (Array.isArray(content)) return extractInlineTextContent(content);
	}
	return "";
}
function countAssistantToolCalls(content) {
	if (!Array.isArray(content)) return 0;
	let count = 0;
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const type = block.type;
		if (type === "toolCall" || type === "tool_use" || type === "toolUse" || type === "functionCall" || type === "function_call") count += 1;
	}
	return count;
}
function summarizeSubagentOutputHistory(messages) {
	const snapshot = {
		assistantFragments: [],
		toolCallCount: 0
	};
	let previousAssistantCalledYield = false;
	for (const message of messages) {
		if (!message || typeof message !== "object") continue;
		if (message.role === "assistant") {
			snapshot.toolCallCount += countAssistantToolCalls(message.content);
			if (assistantCallsSessionsYield(message)) {
				snapshot.latestAssistantText = void 0;
				snapshot.latestRawText = void 0;
				snapshot.latestSilentText = void 0;
				snapshot.assistantFragments = [];
				snapshot.waitingForContinuation = true;
				previousAssistantCalledYield = true;
				continue;
			}
			const text = extractSubagentOutputText(message).trim();
			if (!text) {
				previousAssistantCalledYield = false;
				continue;
			}
			if (isAnnounceSkip(text) || isSilentReplyText(text, "NO_REPLY")) {
				snapshot.latestSilentText = text;
				snapshot.latestAssistantText = void 0;
				snapshot.assistantFragments = [];
				snapshot.waitingForContinuation = false;
				previousAssistantCalledYield = false;
				continue;
			}
			snapshot.latestSilentText = void 0;
			snapshot.latestAssistantText = text;
			snapshot.assistantFragments.push(text);
			snapshot.waitingForContinuation = false;
			previousAssistantCalledYield = false;
			continue;
		}
		if (isSessionsYieldToolResult(message, previousAssistantCalledYield)) {
			snapshot.latestAssistantText = void 0;
			snapshot.latestRawText = void 0;
			snapshot.latestSilentText = void 0;
			snapshot.assistantFragments = [];
			snapshot.waitingForContinuation = true;
			previousAssistantCalledYield = false;
			continue;
		}
		const text = extractSubagentOutputText(message).trim();
		if (text) {
			snapshot.latestRawText = text;
			snapshot.waitingForContinuation = false;
		}
		previousAssistantCalledYield = false;
	}
	return snapshot;
}
function formatSubagentPartialProgress(snapshot, outcome) {
	if (snapshot.latestSilentText) return;
	const timedOut = outcome?.status === "timeout";
	if (snapshot.assistantFragments.length === 0 && (!timedOut || snapshot.toolCallCount === 0)) return;
	const parts = [];
	if (timedOut && snapshot.toolCallCount > 0) parts.push(`[Partial progress: ${snapshot.toolCallCount} tool call(s) executed before timeout]`);
	if (snapshot.assistantFragments.length > 0) parts.push(snapshot.assistantFragments.slice(-3).join("\n\n---\n\n"));
	return parts.join("\n\n") || void 0;
}
function selectSubagentOutputText(snapshot, outcome) {
	if (snapshot.waitingForContinuation) return;
	if (snapshot.latestSilentText) return snapshot.latestSilentText;
	if (snapshot.latestAssistantText) return snapshot.latestAssistantText;
	const partialProgress = formatSubagentPartialProgress(snapshot, outcome);
	if (partialProgress) return partialProgress;
	return snapshot.latestRawText;
}
async function readSubagentOutput(sessionKey, outcome) {
	const history = await subagentAnnounceOutputDeps.callGateway({
		method: "chat.history",
		params: {
			sessionKey,
			limit: 100
		}
	});
	const snapshot = summarizeSubagentOutputHistory(Array.isArray(history?.messages) ? history.messages : []);
	const selected = selectSubagentOutputText(snapshot, outcome);
	if (selected?.trim()) return selected;
	if (snapshot.waitingForContinuation) return;
	const latestAssistant = await subagentAnnounceOutputDeps.readLatestAssistantReply({
		sessionKey,
		limit: 100
	});
	return latestAssistant?.trim() ? latestAssistant : void 0;
}
async function readLatestSubagentOutputWithRetry(params) {
	return await readLatestSubagentOutputWithRetryUsing({
		sessionKey: params.sessionKey,
		maxWaitMs: params.maxWaitMs,
		outcome: params.outcome,
		retryIntervalMs: isFastTestMode() ? FAST_TEST_RETRY_INTERVAL_MS : 100,
		readSubagentOutput
	});
}
async function waitForSubagentRunOutcome(runId, timeoutMs) {
	const waitMs = Math.max(0, Math.floor(timeoutMs));
	return await subagentAnnounceOutputDeps.callGateway({
		method: "agent.wait",
		params: {
			runId,
			timeoutMs: waitMs
		},
		timeoutMs: waitMs + 2e3
	});
}
function applySubagentWaitOutcome(params) {
	const next = {
		outcome: params.outcome,
		startedAt: params.startedAt,
		endedAt: params.endedAt
	};
	if (typeof params.wait?.startedAt === "number" && typeof next.startedAt !== "number") next.startedAt = params.wait.startedAt;
	if (typeof params.wait?.endedAt === "number" && typeof next.endedAt !== "number") next.endedAt = params.wait.endedAt;
	const waitError = typeof params.wait?.error === "string" ? params.wait.error : void 0;
	let outcome = next.outcome;
	if (isBlockedLivenessState(params.wait?.livenessState)) outcome = {
		status: "error",
		error: formatBlockedLivenessError(waitError)
	};
	else if (params.wait?.status === "timeout") outcome = { status: "timeout" };
	else if (params.wait?.status === "error") outcome = {
		status: "error",
		error: waitError
	};
	else if (params.wait?.status === "ok") outcome = { status: "ok" };
	next.outcome = outcome ? withSubagentOutcomeTiming(outcome, next) : void 0;
	return next;
}
async function captureSubagentCompletionReply(sessionKey, options) {
	return await captureSubagentCompletionReplyUsing({
		sessionKey,
		waitForReply: options?.waitForReply,
		maxWaitMs: isFastTestMode() ? 50 : 1500,
		retryIntervalMs: isFastTestMode() ? FAST_TEST_RETRY_INTERVAL_MS : 100,
		readSubagentOutput: async (nextSessionKey) => await readSubagentOutput(nextSessionKey, options?.outcome)
	});
}
function describeSubagentOutcome(outcome) {
	if (!outcome) return "unknown";
	if (outcome.status === "ok") return "ok";
	if (outcome.status === "timeout") return "timeout";
	if (outcome.status === "error") return outcome.error?.trim() ? `error: ${outcome.error.trim()}` : "error";
	return "unknown";
}
function formatChildResultData(resultText) {
	return wrapPromptDataBlock({
		label: "Child result",
		text: resultText?.trim() || "(no output)"
	}) || "Child result: (no output)";
}
function buildChildCompletionFindings(children) {
	const sorted = [...children].toSorted((a, b) => {
		if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
		return (typeof a.endedAt === "number" ? a.endedAt : Number.MAX_SAFE_INTEGER) - (typeof b.endedAt === "number" ? b.endedAt : Number.MAX_SAFE_INTEGER);
	});
	const sections = [];
	for (const [index, child] of sorted.entries()) {
		const resultText = child.frozenResultText?.trim();
		const outcome = describeSubagentOutcome(child.outcome);
		if (child.outcome?.status === "ok" && resultText && (isAnnounceSkip(resultText) || isSilentReplyText(resultText, "NO_REPLY"))) continue;
		const title = child.label?.trim() || child.task.trim() || child.childSessionKey.trim() || `child ${index + 1}`;
		const displayIndex = sections.length + 1;
		sections.push([
			`${displayIndex}. ${title}`,
			`status: ${outcome}`,
			formatChildResultData(resultText)
		].join("\n"));
	}
	if (sections.length === 0) return;
	return [
		"Child completion results:",
		"",
		...sections
	].join("\n\n");
}
function dedupeLatestChildCompletionRows(children) {
	const latestByChildSessionKey = /* @__PURE__ */ new Map();
	for (const child of children) {
		const existing = latestByChildSessionKey.get(child.childSessionKey);
		if (!existing || child.createdAt > existing.createdAt) latestByChildSessionKey.set(child.childSessionKey, child);
	}
	return [...latestByChildSessionKey.values()];
}
function filterCurrentDirectChildCompletionRows(children, params) {
	if (typeof params.getLatestSubagentRunByChildSessionKey !== "function") return children;
	return children.filter((child) => {
		const latest = params.getLatestSubagentRunByChildSessionKey?.(child.childSessionKey);
		if (!latest) return true;
		return latest.runId === child.runId && latest.requesterSessionKey === params.requesterSessionKey;
	});
}
function formatDurationShort(valueMs) {
	if (!valueMs || !Number.isFinite(valueMs) || valueMs <= 0) return "n/a";
	const totalSeconds = Math.round(valueMs / 1e3);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor(totalSeconds % 3600 / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) return `${hours}h${minutes}m`;
	if (minutes > 0) return `${minutes}m${seconds}s`;
	return `${seconds}s`;
}
function formatTokenCount(value) {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "0";
	if (value >= 1e6) return `${(value / 1e6).toFixed(1)}m`;
	if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
	return String(Math.round(value));
}
async function buildCompactAnnounceStatsLine(params) {
	const cfg = subagentAnnounceOutputDeps.getRuntimeConfig();
	const agentId = resolveAgentIdFromSessionKey(params.sessionKey);
	const storePath = resolveStorePath(cfg.session?.store, { agentId });
	let entry = readSessionEntry(storePath, params.sessionKey);
	const tokenWaitAttempts = isFastTestMode() ? 1 : 3;
	for (let attempt = 0; attempt < tokenWaitAttempts; attempt += 1) {
		if (typeof entry?.inputTokens === "number" || typeof entry?.outputTokens === "number" || typeof entry?.totalTokens === "number") break;
		if (!isFastTestMode()) await new Promise((resolve) => setTimeout(resolve, 150));
		entry = readSessionEntry(storePath, params.sessionKey);
	}
	const input = typeof entry?.inputTokens === "number" ? entry.inputTokens : 0;
	const output = typeof entry?.outputTokens === "number" ? entry.outputTokens : 0;
	const ioTotal = input + output;
	const promptCache = typeof entry?.totalTokens === "number" ? entry.totalTokens : void 0;
	const parts = [`runtime ${formatDurationShort(typeof params.startedAt === "number" && typeof params.endedAt === "number" ? Math.max(0, params.endedAt - params.startedAt) : void 0)}`, `tokens ${formatTokenCount(ioTotal)} (in ${formatTokenCount(input)} / out ${formatTokenCount(output)})`];
	if (typeof promptCache === "number" && promptCache > ioTotal) parts.push(`prompt/cache ${formatTokenCount(promptCache)}`);
	return `Stats: ${parts.join(" • ")}`;
}
//#endregion
//#region src/agents/subagent-session-cleanup.ts
async function deleteSubagentSessionForCleanup(params) {
	try {
		await params.callGateway({
			method: "sessions.delete",
			params: {
				key: params.childSessionKey,
				deleteTranscript: true,
				emitLifecycleHooks: params.spawnMode === "session"
			},
			timeoutMs: 1e4
		});
	} catch (error) {
		params.onError?.(error);
	}
}
//#endregion
export { isReplySkip as _, captureSubagentCompletionReply as a, readLatestSubagentOutputWithRetry as c, withSubagentOutcomeTiming as d, runAgentStep as f, isNonDeliverableSessionsReply as g, isAnnounceSkip as h, buildCompactAnnounceStatsLine as i, readSubagentOutput as l, REPLY_SKIP_TOKEN as m, applySubagentWaitOutcome as n, dedupeLatestChildCompletionRows as o, ANNOUNCE_SKIP_TOKEN as p, buildChildCompletionFindings as r, filterCurrentDirectChildCompletionRows as s, deleteSubagentSessionForCleanup as t, waitForSubagentRunOutcome as u };
