import { i as formatErrorMessage } from "./errors-VfATXfah.js";
import { i as callGateway } from "./call-DO7ujqcl.js";
import { r as stripToolMessages, t as extractAssistantText } from "./chat-history-text-DY_gaDpD.js";
let runWaitDeps = { callGateway };
function normalizeAgentWaitResult(status, wait) {
	return {
		status,
		error: typeof wait?.error === "string" ? wait.error : void 0,
		startedAt: typeof wait?.startedAt === "number" ? wait.startedAt : void 0,
		endedAt: typeof wait?.endedAt === "number" ? wait.endedAt : void 0,
		stopReason: typeof wait?.stopReason === "string" ? wait.stopReason : void 0,
		livenessState: typeof wait?.livenessState === "string" ? wait.livenessState : void 0,
		yielded: wait?.yielded === true ? true : void 0
	};
}
const RECOVERABLE_AGENT_WAIT_ERROR_PATTERNS = [
	/gateway closed \(1006/i,
	/transport close/i,
	/connection loss/i,
	/connection closed/i,
	/gateway not connected/i,
	/no active .* listener/i,
	/socket hang up/i,
	/\b(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EHOSTUNREACH|ENETUNREACH)\b/i
];
function isRecoverableAgentWaitError(error) {
	const message = error?.trim();
	if (!message) return false;
	if (message.includes("gateway timeout")) return false;
	return RECOVERABLE_AGENT_WAIT_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}
function normalizePendingRunIds(runIds) {
	const seen = /* @__PURE__ */ new Set();
	for (const runId of runIds) {
		const normalized = runId.trim();
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
	}
	return [...seen];
}
function resolveLatestAssistantReplySnapshot(messages) {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const candidate = messages[i];
		if (!candidate || typeof candidate !== "object") continue;
		if (candidate.role !== "assistant") continue;
		const text = extractAssistantText(candidate);
		if (!text?.trim()) continue;
		let fingerprint;
		try {
			fingerprint = JSON.stringify(candidate);
		} catch {
			fingerprint = text;
		}
		return {
			text,
			fingerprint
		};
	}
	return {};
}
async function readLatestAssistantReplySnapshot(params) {
	const history = await (params.callGateway ?? runWaitDeps.callGateway)({
		method: "chat.history",
		params: {
			sessionKey: params.sessionKey,
			limit: params.limit ?? 50
		}
	});
	return resolveLatestAssistantReplySnapshot(stripToolMessages(Array.isArray(history?.messages) ? history.messages : []));
}
async function readLatestAssistantReply(params) {
	return (await readLatestAssistantReplySnapshot({
		sessionKey: params.sessionKey,
		limit: params.limit,
		callGateway: params.callGateway
	})).text;
}
async function waitForAgentRun(params) {
	const timeoutMs = Math.max(1, Math.floor(params.timeoutMs));
	try {
		const wait = await (params.callGateway ?? runWaitDeps.callGateway)({
			method: "agent.wait",
			params: {
				runId: params.runId,
				timeoutMs
			},
			timeoutMs: timeoutMs + 2e3
		});
		if (wait?.status === "timeout") return normalizeAgentWaitResult("timeout", wait);
		if (wait?.status === "pending") return normalizeAgentWaitResult("pending", wait);
		if (wait?.status === "error") return normalizeAgentWaitResult("error", wait);
		return normalizeAgentWaitResult("ok", wait);
	} catch (err) {
		const error = formatErrorMessage(err);
		return {
			status: error.includes("gateway timeout") ? "timeout" : "error",
			error
		};
	}
}
async function waitForAgentRunAndReadUpdatedAssistantReply(params) {
	const wait = await waitForAgentRun({
		runId: params.runId,
		timeoutMs: params.timeoutMs,
		callGateway: params.callGateway
	});
	if (wait.status !== "ok") return wait;
	const latestReply = await readLatestAssistantReplySnapshot({
		sessionKey: params.sessionKey,
		limit: params.limit,
		callGateway: params.callGateway
	});
	const baselineFingerprint = params.baseline?.fingerprint;
	return {
		status: "ok",
		replyText: latestReply.text && (!baselineFingerprint || latestReply.fingerprint !== baselineFingerprint) ? latestReply.text : void 0
	};
}
async function waitForAgentRunsToDrain(params) {
	const deadlineAtMs = params.deadlineAtMs ?? Date.now() + Math.max(1, Math.floor(params.timeoutMs ?? 0));
	let pendingRunIds = new Set(normalizePendingRunIds(params.initialPendingRunIds ?? params.getPendingRunIds()));
	while (pendingRunIds.size > 0 && Date.now() < deadlineAtMs) {
		const remainingMs = Math.max(1, deadlineAtMs - Date.now());
		await Promise.allSettled([...pendingRunIds].map((runId) => waitForAgentRun({
			runId,
			timeoutMs: remainingMs,
			callGateway: params.callGateway
		})));
		pendingRunIds = new Set(normalizePendingRunIds(params.getPendingRunIds()));
	}
	return {
		timedOut: pendingRunIds.size > 0,
		pendingRunIds: [...pendingRunIds],
		deadlineAtMs
	};
}
//#endregion
export { waitForAgentRunAndReadUpdatedAssistantReply as a, waitForAgentRun as i, readLatestAssistantReply as n, waitForAgentRunsToDrain as o, readLatestAssistantReplySnapshot as r, isRecoverableAgentWaitError as t };
