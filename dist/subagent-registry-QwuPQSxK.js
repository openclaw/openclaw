import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { c as readErrorName, i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { n as createLazyPromiseLoader, t as createLazyImportLoader } from "./lazy-promise-Djskx0qC.js";
import { d as resolveAgentIdFromSessionKey } from "./session-key-Bte0mmcq.js";
import { n as defaultRuntime } from "./runtime-yzlkhCoS.js";
import { s as toSafeImportPath } from "./plugin-module-loader-cache-D0U0PNnl.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { i as getRuntimeConfig } from "./io-DoswVvYe.js";
import "./config-B6Oplu5W.js";
import { r as callGateway } from "./call-t1U2G3yY.js";
import { t as getGlobalHookRunner } from "./hook-runner-global-BkXXy1ub.js";
import { c as getAgentRunContext, l as onAgentEvent } from "./agent-events-BuYtWSh4.js";
import { o as normalizeDeliveryContext } from "./delivery-context.shared-CBmB9dF7.js";
import { u as resolveStorePath } from "./paths-Bg3PO6Gj.js";
import { c as registerSessionMaintenancePreserveKeysProvider, t as loadSessionStore } from "./store-load-z4thf6ld.js";
import { u as updateSessionStore } from "./store-BmtchQvp.js";
import "./sessions-CQHHcgC_.js";
import { n as resolveRequiredCompletionTerminalResult, r as resolveAgentTimeoutMs, t as resolveRequiredCompletionDeliveryFailureTerminalResult } from "./task-completion-contract-D5t-_eBh.js";
import { n as extractTextFromChatContent } from "./chat-content-BNTcXm1Z.js";
import { a as failTaskRunByRunId, i as createRunningTaskRun, l as setDetachedTaskDeliveryStatusByRunId, n as completeTaskRunByRunId } from "./detached-task-runtime-C79km_82.js";
import { a as isSilentReplyText } from "./tokens-CFv3Qu_v.js";
import { A as SUBAGENT_ENDED_REASON_KILLED, C as getSubagentSessionStartedAt, D as SUBAGENT_ENDED_OUTCOME_TIMEOUT, E as SUBAGENT_ENDED_OUTCOME_KILLED, M as subagentRuns, O as SUBAGENT_ENDED_REASON_COMPLETE, S as getSubagentSessionRuntimeMs, T as SUBAGENT_ENDED_OUTCOME_ERROR, b as isStaleUnendedSubagentRun, f as listDescendantRunsForRequesterFromRuns, i as restoreSubagentRunsFromDisk, j as SUBAGENT_TARGET_KIND_SUBAGENT, k as SUBAGENT_ENDED_REASON_ERROR, l as countPendingDescendantRunsFromRuns, n as persistSubagentRunsToDisk, o as countActiveDescendantRunsFromRuns, p as listRunsForControllerFromRuns, r as persistSubagentRunsToDiskOrThrow, s as countActiveRunsForSessionFromRuns, t as getSubagentRunsSnapshotForRead, u as getSubagentRunByChildSessionKeyFromRuns, w as resolveSubagentSessionStatus } from "./subagent-registry-state-DbOPrqYx.js";
import { c as retireSessionMcpRuntimeForSessionKey } from "./pi-bundle-mcp-runtime-CwBDIKIq.js";
import "./pi-bundle-mcp-tools-_xKQdIka.js";
import { i as waitForAgentRun, l as formatBlockedLivenessError, t as isRecoverableAgentWaitError, u as isBlockedLivenessState } from "./run-wait-BlZoP48F.js";
import { d as withSubagentOutcomeTiming, t as deleteSubagentSessionForCleanup } from "./subagent-session-cleanup-B3w9Gz1A.js";
import { t as emitSessionLifecycleEvent } from "./session-lifecycle-events-CrY3-yco.js";
import { n as buildAnnounceIdempotencyKey, t as buildAnnounceIdFromChildRun } from "./announce-idempotency-DV6_8Blm.js";
import { t as configureSubagentRegistrySteerRuntime } from "./subagent-registry-steer-runtime-9Vso0zzU.js";
import fs, { promises } from "node:fs";
import path from "node:path";
//#region src/shared/runtime-import.ts
function resolveRuntimeImportSpecifier(baseUrl, parts) {
	const joined = parts.join("");
	const safeJoined = toSafeImportPath(joined);
	if (safeJoined !== joined) return safeJoined;
	return new URL(joined, toSafeImportPath(baseUrl)).href;
}
async function importRuntimeModule(baseUrl, parts, importModule = (specifier) => import(specifier)) {
	return await importModule(resolveRuntimeImportSpecifier(baseUrl, parts));
}
//#endregion
//#region src/agents/subagent-registry-completion.ts
function runOutcomesEqual(a, b) {
	if (!a && !b) return true;
	if (!a || !b) return false;
	if (a.status !== b.status) return false;
	if (a.status === "error" && b.status === "error") {
		if ((a.error ?? "") !== (b.error ?? "")) return false;
	}
	if (!runOutcomeHasTiming(a) || !runOutcomeHasTiming(b)) return true;
	return a.startedAt === b.startedAt && a.endedAt === b.endedAt && a.elapsedMs === b.elapsedMs;
}
function runOutcomeHasTiming(outcome) {
	return Number.isFinite(outcome?.startedAt) || Number.isFinite(outcome?.endedAt) || Number.isFinite(outcome?.elapsedMs);
}
function shouldUpdateRunOutcome(current, next) {
	return !runOutcomesEqual(current, next) || !runOutcomeHasTiming(current) && runOutcomeHasTiming(next);
}
function resolveLifecycleOutcomeFromRunOutcome(outcome) {
	if (outcome?.status === "error") return SUBAGENT_ENDED_OUTCOME_ERROR;
	if (outcome?.status === "timeout") return SUBAGENT_ENDED_OUTCOME_TIMEOUT;
	return "ok";
}
async function emitSubagentEndedHookOnce(params) {
	const runId = params.entry.runId.trim();
	if (!runId) return false;
	if (params.entry.endedHookEmittedAt) return false;
	if (params.inFlightRunIds.has(runId)) return false;
	params.inFlightRunIds.add(runId);
	try {
		const hookRunner = getGlobalHookRunner();
		if (!hookRunner) return false;
		if (hookRunner?.hasHooks("subagent_ended")) await hookRunner.runSubagentEnded({
			targetSessionKey: params.entry.childSessionKey,
			targetKind: SUBAGENT_TARGET_KIND_SUBAGENT,
			reason: params.reason,
			sendFarewell: params.sendFarewell,
			accountId: params.accountId,
			runId: params.entry.runId,
			endedAt: params.entry.endedAt,
			outcome: params.outcome,
			error: params.error
		}, {
			runId: params.entry.runId,
			childSessionKey: params.entry.childSessionKey,
			requesterSessionKey: params.entry.requesterSessionKey
		});
		params.entry.endedHookEmittedAt = Date.now();
		params.persist();
		return true;
	} catch {
		return false;
	} finally {
		params.inFlightRunIds.delete(runId);
	}
}
//#endregion
//#region src/agents/subagent-registry-helpers.ts
const MIN_ANNOUNCE_RETRY_DELAY_MS = 1e3;
const MAX_ANNOUNCE_RETRY_DELAY_MS = 8e3;
const ANNOUNCE_EXPIRY_MS = 5 * 6e4;
const ANNOUNCE_COMPLETION_HARD_EXPIRY_MS = 30 * 6e4;
const FROZEN_RESULT_TEXT_MAX_BYTES = 100 * 1024;
function capFrozenResultText(resultText) {
	const trimmed = resultText.trim();
	if (!trimmed) return "";
	const totalBytes = Buffer.byteLength(trimmed, "utf8");
	if (totalBytes <= FROZEN_RESULT_TEXT_MAX_BYTES) return trimmed;
	const notice = `\n\n[truncated: frozen completion output exceeded ${Math.round(FROZEN_RESULT_TEXT_MAX_BYTES / 1024)}KB (${Math.round(totalBytes / 1024)}KB)]`;
	const maxPayloadBytes = Math.max(0, FROZEN_RESULT_TEXT_MAX_BYTES - Buffer.byteLength(notice, "utf8"));
	return `${Buffer.from(trimmed, "utf8").subarray(0, maxPayloadBytes).toString("utf8")}${notice}`;
}
function resolveAnnounceRetryDelayMs(retryCount) {
	const baseDelay = MIN_ANNOUNCE_RETRY_DELAY_MS * 2 ** Math.max(0, Math.max(0, Math.min(retryCount, 10)) - 1);
	return Math.min(baseDelay, MAX_ANNOUNCE_RETRY_DELAY_MS);
}
function formatAnnounceGiveUpLogField(value) {
	const normalized = value.replace(/\s+/g, " ").trim();
	return JSON.stringify(normalized.length > 2e3 ? `${normalized.slice(0, 2e3)}…` : normalized);
}
function logAnnounceGiveUp(entry, reason) {
	const retryCount = entry.announceRetryCount ?? 0;
	const endedAgoMs = typeof entry.endedAt === "number" ? Math.max(0, Date.now() - entry.endedAt) : void 0;
	const endedAgoLabel = endedAgoMs != null ? `${Math.round(endedAgoMs / 1e3)}s` : "n/a";
	const deliveryError = entry.lastAnnounceDeliveryError?.trim() ? ` deliveryError=${formatAnnounceGiveUpLogField(entry.lastAnnounceDeliveryError)}` : "";
	defaultRuntime.log(`[warn] Subagent announce give up (${reason}) run=${entry.runId} child=${entry.childSessionKey} requester=${entry.requesterSessionKey} retries=${retryCount} endedAgo=${endedAgoLabel}${deliveryError}`);
}
function findSessionEntryByKey$1(store, sessionKey) {
	const direct = store[sessionKey];
	if (direct) return direct;
	const normalized = normalizeLowercaseStringOrEmpty(sessionKey);
	for (const [key, entry] of Object.entries(store)) if (normalizeLowercaseStringOrEmpty(key) === normalized) return entry;
}
async function persistSubagentSessionTiming(entry) {
	const childSessionKey = entry.childSessionKey?.trim();
	if (!childSessionKey) return;
	const cfg = getRuntimeConfig();
	const agentId = resolveAgentIdFromSessionKey(childSessionKey);
	const storePath = resolveStorePath(cfg.session?.store, { agentId });
	const startedAt = getSubagentSessionStartedAt(entry);
	const endedAt = typeof entry.endedAt === "number" && Number.isFinite(entry.endedAt) ? entry.endedAt : void 0;
	const runtimeMs = endedAt !== void 0 ? getSubagentSessionRuntimeMs(entry, endedAt) : getSubagentSessionRuntimeMs(entry);
	const status = resolveSubagentSessionStatus(entry);
	await updateSessionStore(storePath, (store) => {
		const sessionEntry = findSessionEntryByKey$1(store, childSessionKey);
		if (!sessionEntry) return;
		if (typeof startedAt === "number" && Number.isFinite(startedAt)) sessionEntry.startedAt = startedAt;
		else delete sessionEntry.startedAt;
		if (typeof endedAt === "number" && Number.isFinite(endedAt)) sessionEntry.endedAt = endedAt;
		else delete sessionEntry.endedAt;
		if (typeof runtimeMs === "number" && Number.isFinite(runtimeMs)) sessionEntry.runtimeMs = runtimeMs;
		else delete sessionEntry.runtimeMs;
		if (status) sessionEntry.status = status;
		else delete sessionEntry.status;
	});
}
function resolveSubagentRunOrphanReason(params) {
	const childSessionKey = params.entry.childSessionKey?.trim();
	if (!childSessionKey) return "missing-session-entry";
	try {
		const cfg = getRuntimeConfig();
		const agentId = resolveAgentIdFromSessionKey(childSessionKey);
		const storePath = resolveStorePath(cfg.session?.store, { agentId });
		let store = params.storeCache?.get(storePath);
		if (!store) {
			store = loadSessionStore(storePath);
			params.storeCache?.set(storePath, store);
		}
		const sessionEntry = findSessionEntryByKey$1(store, childSessionKey);
		if (!sessionEntry) return "missing-session-entry";
		if (typeof sessionEntry.sessionId !== "string" || !sessionEntry.sessionId.trim()) return "missing-session-id";
		if (params.includeStaleUnended === true && sessionEntry.abortedLastRun !== true && isStaleUnendedSubagentRun(params.entry, params.now)) return "stale-unended-run";
		return null;
	} catch {
		return null;
	}
}
function isResolvedChildPath(params) {
	const rootWithSep = params.rootPath.endsWith(path.sep) ? params.rootPath : `${params.rootPath}${path.sep}`;
	return params.childPath.startsWith(rootWithSep);
}
async function safeRemoveAttachmentsDir(entry) {
	if (!entry.attachmentsDir || !entry.attachmentsRootDir) return;
	const resolveReal = async (targetPath) => {
		try {
			return await promises.realpath(targetPath);
		} catch (err) {
			if (err?.code === "ENOENT") return null;
			throw err;
		}
	};
	try {
		const [rootReal, dirReal] = await Promise.all([resolveReal(entry.attachmentsRootDir), resolveReal(entry.attachmentsDir)]);
		if (!dirReal) return;
		const rootBase = rootReal ?? path.resolve(entry.attachmentsRootDir);
		const dirBase = dirReal;
		if (!isResolvedChildPath({
			childPath: dirBase,
			rootPath: rootBase
		})) return;
		await promises.rm(dirBase, {
			recursive: true,
			force: true
		});
	} catch {}
}
function safeRemoveAttachmentsDirSync(entry) {
	if (!entry.attachmentsDir || !entry.attachmentsRootDir) return;
	const resolveReal = (targetPath) => {
		try {
			return fs.realpathSync.native(targetPath);
		} catch (err) {
			if (err?.code === "ENOENT") return null;
			throw err;
		}
	};
	try {
		const rootReal = resolveReal(entry.attachmentsRootDir);
		const dirReal = resolveReal(entry.attachmentsDir);
		if (!dirReal) return;
		if (!isResolvedChildPath({
			childPath: dirReal,
			rootPath: rootReal ?? path.resolve(entry.attachmentsRootDir)
		})) return;
		fs.rmSync(dirReal, {
			recursive: true,
			force: true
		});
	} catch {}
}
function reconcileOrphanedRun(params) {
	const now = Date.now();
	let changed = false;
	if (typeof params.entry.endedAt !== "number") {
		params.entry.endedAt = now;
		changed = true;
	}
	const orphanOutcome = withSubagentOutcomeTiming({
		status: "error",
		error: `orphaned subagent run (${params.reason})`
	}, {
		startedAt: params.entry.startedAt,
		endedAt: params.entry.endedAt
	});
	if (shouldUpdateRunOutcome(params.entry.outcome, orphanOutcome)) {
		params.entry.outcome = orphanOutcome;
		changed = true;
	}
	if (params.entry.endedReason !== "subagent-error") {
		params.entry.endedReason = SUBAGENT_ENDED_REASON_ERROR;
		changed = true;
	}
	if (params.entry.cleanupHandled !== true) {
		params.entry.cleanupHandled = true;
		changed = true;
	}
	if (typeof params.entry.cleanupCompletedAt !== "number") {
		params.entry.cleanupCompletedAt = now;
		changed = true;
	}
	if (params.entry.cleanup === "delete" || !params.entry.retainAttachmentsOnKeep) safeRemoveAttachmentsDirSync(params.entry);
	const removed = params.runs.delete(params.runId);
	params.resumedRuns.delete(params.runId);
	if (!removed && !changed) return false;
	defaultRuntime.log(`[warn] Subagent orphan run pruned source=${params.source} run=${params.runId} child=${params.entry.childSessionKey} reason=${params.reason}`);
	return true;
}
function reconcileOrphanedRestoredRuns(params) {
	const storeCache = /* @__PURE__ */ new Map();
	const now = Date.now();
	let changed = false;
	for (const [runId, entry] of params.runs.entries()) {
		const orphanReason = resolveSubagentRunOrphanReason({
			entry,
			storeCache,
			includeStaleUnended: true,
			now
		});
		if (!orphanReason) continue;
		if (reconcileOrphanedRun({
			runId,
			entry,
			reason: orphanReason,
			source: "restore",
			runs: params.runs,
			resumedRuns: params.resumedRuns
		})) changed = true;
	}
	return changed;
}
function resolveArchiveAfterMs(cfg) {
	const minutes = (cfg ?? getRuntimeConfig()).agents?.defaults?.subagents?.archiveAfterMinutes ?? 60;
	if (!Number.isFinite(minutes) || minutes < 0) return;
	if (minutes === 0) return;
	return Math.max(1, Math.floor(minutes)) * 6e4;
}
//#endregion
//#region src/agents/subagent-registry-cleanup.ts
function resolveCleanupCompletionReason(entry) {
	return entry.endedReason ?? "subagent-complete";
}
function resolveEndedAgoMs(entry, now) {
	return typeof entry.endedAt === "number" ? now - entry.endedAt : 0;
}
function resolveDeferredCleanupDecision(params) {
	const endedAgo = resolveEndedAgoMs(params.entry, params.now);
	const isCompletionMessageFlow = params.entry.expectsCompletionMessage === true;
	const completionHardExpiryExceeded = isCompletionMessageFlow && endedAgo > params.announceCompletionHardExpiryMs;
	if (isCompletionMessageFlow && params.activeDescendantRuns > 0) {
		if (completionHardExpiryExceeded) return {
			kind: "give-up",
			reason: "expiry"
		};
		return {
			kind: "defer-descendants",
			delayMs: params.deferDescendantDelayMs
		};
	}
	const retryCount = (params.entry.announceRetryCount ?? 0) + 1;
	const expiryExceeded = isCompletionMessageFlow ? completionHardExpiryExceeded : endedAgo > params.announceExpiryMs;
	if (retryCount >= params.maxAnnounceRetryCount || expiryExceeded) return {
		kind: "give-up",
		reason: retryCount >= params.maxAnnounceRetryCount ? "retry-limit" : "expiry",
		retryCount
	};
	return {
		kind: "retry",
		retryCount,
		resumeDelayMs: params.resolveAnnounceRetryDelayMs(retryCount)
	};
}
//#endregion
//#region src/agents/subagent-registry-lifecycle.ts
const DELIVERY_MIRROR_HISTORY_MAX_CHARS = 128 * 1024;
const browserCleanupLoader$1 = createLazyImportLoader(() => import("./browser-lifecycle-cleanup-CbRipfw2.js"));
async function loadCleanupBrowserSessionsForLifecycleEnd$1() {
	return (await browserCleanupLoader$1.load()).cleanupBrowserSessionsForLifecycleEnd;
}
function createSubagentRegistryLifecycleController(params) {
	const scheduledResumeTimers = /* @__PURE__ */ new Set();
	const scheduleResumeSubagentRun = (runId, entry, delayMs) => {
		const timer = setTimeout(() => {
			scheduledResumeTimers.delete(timer);
			if (params.runs.get(runId) !== entry) return;
			params.resumeSubagentRun(runId);
		}, delayMs);
		timer.unref?.();
		scheduledResumeTimers.add(timer);
	};
	const clearScheduledResumeTimers = () => {
		for (const timer of scheduledResumeTimers) clearTimeout(timer);
		scheduledResumeTimers.clear();
	};
	const maskRunId = (runId) => {
		const trimmed = runId.trim();
		if (!trimmed) return "unknown";
		if (trimmed.length <= 8) return "***";
		return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
	};
	const maskSessionKey = (sessionKey) => {
		const trimmed = sessionKey.trim();
		if (!trimmed) return "unknown";
		return `${trimmed.split(":").slice(0, 2).join(":") || "session"}:…`;
	};
	const buildSafeLifecycleErrorMeta = (err) => {
		const message = formatErrorMessage(err);
		const name = readErrorName(err);
		return name ? {
			name,
			message
		} : { message };
	};
	const formatAnnounceDeliveryError = (delivery) => {
		const errors = [delivery.error, ...(delivery.phases ?? []).map((phase) => phase.error ? `${phase.phase}: ${phase.error}` : void 0)].map((value) => value?.trim()).filter((value) => Boolean(value));
		return errors.length > 0 ? [...new Set(errors)].join("; ") : `delivery path ${delivery.path} did not complete`;
	};
	const recordAnnounceDeliveryResult = (entry, delivery) => {
		if (typeof delivery.enqueuedAt === "number") entry.completionEnqueuedAt ??= delivery.enqueuedAt;
		if (delivery.delivered) {
			entry.completionDeliveredAt = typeof delivery.deliveredAt === "number" ? delivery.deliveredAt : Date.now();
			entry.lastAnnounceDropReason = void 0;
		}
	};
	const hasPriorRequesterDeliveryMirror = async (entry) => {
		const expectedText = extractTextFromChatContent(entry.frozenResultText, { joinWith: "" });
		if (entry.expectsCompletionMessage !== true || expectedText == null) return false;
		const mirrorNotBefore = entry.startedAt ?? entry.createdAt;
		const mirrorNotAfter = Date.now() + 3e4;
		const expectedIdempotencyKey = buildAnnounceIdempotencyKey(buildAnnounceIdFromChildRun({
			childSessionKey: entry.childSessionKey,
			childRunId: entry.runId
		}));
		const isExpectedMirrorIdempotencyKey = (value) => typeof value === "string" && (value === expectedIdempotencyKey || value.startsWith(`${expectedIdempotencyKey}:internal-source-reply:`) || value.startsWith(`${expectedIdempotencyKey}:message-tool:internal-source-reply:`) || value.startsWith(`${entry.runId}:message-tool:`) || value.startsWith(`${entry.runId}:internal-source-reply:`));
		try {
			const mirror = (await params.callGateway({
				method: "chat.history",
				params: {
					sessionKey: entry.requesterSessionKey,
					limit: 25,
					maxChars: DELIVERY_MIRROR_HISTORY_MAX_CHARS
				},
				timeoutMs: 5e3
			})).messages?.find((message) => {
				if (!message || typeof message !== "object") return false;
				const record = message;
				const timestamp = record.timestamp;
				if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp < mirrorNotBefore || timestamp > mirrorNotAfter || !isExpectedMirrorIdempotencyKey(record.idempotencyKey)) return false;
				const text = extractTextFromChatContent(record.content, { joinWith: "" });
				return record.role === "assistant" && record.provider === "openclaw" && record.model === "delivery-mirror" && text === expectedText;
			});
			if (mirror) entry.completionDeliveredAt = mirror.timestamp;
			return Boolean(mirror);
		} catch {
			return false;
		}
	};
	const safeSetSubagentTaskDeliveryStatus = (args) => {
		try {
			setDetachedTaskDeliveryStatusByRunId({
				runId: args.runId,
				runtime: "subagent",
				sessionKey: args.childSessionKey,
				deliveryStatus: args.deliveryStatus,
				error: args.deliveryStatus === "failed" ? args.deliveryError : void 0
			});
		} catch (err) {
			params.warn("failed to update subagent background task delivery state", {
				error: buildSafeLifecycleErrorMeta(err),
				runId: maskRunId(args.runId),
				childSessionKey: maskSessionKey(args.childSessionKey),
				deliveryStatus: args.deliveryStatus
			});
		}
	};
	const safeFinalizeSubagentTaskRun = (args) => {
		const endedAt = args.entry.endedAt ?? Date.now();
		const lastEventAt = endedAt;
		try {
			if (args.outcome.status === "ok") {
				const terminalResult = args.entry.expectsCompletionMessage === true ? resolveRequiredCompletionTerminalResult(args.entry.frozenResultText) : {};
				completeTaskRunByRunId({
					runId: args.entry.runId,
					runtime: "subagent",
					sessionKey: args.entry.childSessionKey,
					endedAt,
					lastEventAt,
					progressSummary: args.entry.frozenResultText ?? void 0,
					terminalSummary: terminalResult.terminalSummary ?? null,
					terminalOutcome: terminalResult.terminalOutcome
				});
				return;
			}
			failTaskRunByRunId({
				runId: args.entry.runId,
				runtime: "subagent",
				sessionKey: args.entry.childSessionKey,
				status: args.outcome.status === "timeout" ? "timed_out" : "failed",
				endedAt,
				lastEventAt,
				error: args.outcome.status === "error" ? args.outcome.error : void 0,
				progressSummary: args.entry.frozenResultText ?? void 0,
				terminalSummary: null
			});
		} catch (err) {
			params.warn("failed to finalize subagent background task state", {
				error: buildSafeLifecycleErrorMeta(err),
				runId: maskRunId(args.entry.runId),
				childSessionKey: maskSessionKey(args.entry.childSessionKey),
				outcomeStatus: args.outcome.status
			});
		}
	};
	const safeMarkRequiredCompletionDeliveryBlocked = (args) => {
		if (args.entry.expectsCompletionMessage !== true || args.entry.outcome?.status !== "ok") return;
		const endedAt = args.entry.endedAt ?? Date.now();
		const terminalResult = resolveRequiredCompletionDeliveryFailureTerminalResult(args.reason);
		try {
			completeTaskRunByRunId({
				runId: args.entry.runId,
				runtime: "subagent",
				sessionKey: args.entry.childSessionKey,
				endedAt,
				lastEventAt: Date.now(),
				progressSummary: args.entry.frozenResultText ?? void 0,
				terminalSummary: terminalResult.terminalSummary,
				terminalOutcome: terminalResult.terminalOutcome
			});
		} catch (err) {
			params.warn("failed to mark subagent completion delivery blocked", {
				error: buildSafeLifecycleErrorMeta(err),
				runId: maskRunId(args.entry.runId),
				childSessionKey: maskSessionKey(args.entry.childSessionKey)
			});
		}
	};
	const freezeRunResultAtCompletion = async (entry, outcome) => {
		if (entry.frozenResultText !== void 0) return false;
		if (outcome.status === "error") {
			entry.frozenResultText = null;
			entry.frozenResultCapturedAt = Date.now();
			return true;
		}
		try {
			const captured = await params.captureSubagentCompletionReply(entry.childSessionKey, {
				waitForReply: entry.expectsCompletionMessage === true,
				outcome
			});
			entry.frozenResultText = captured?.trim() ? capFrozenResultText(captured) : null;
		} catch {
			entry.frozenResultText = null;
		}
		entry.frozenResultCapturedAt = Date.now();
		return true;
	};
	const listPendingCompletionRunsForSession = (sessionKey) => {
		const key = sessionKey.trim();
		if (!key) return [];
		const out = [];
		for (const entry of params.runs.values()) {
			if (entry.childSessionKey !== key) continue;
			if (entry.expectsCompletionMessage !== true) continue;
			if (typeof entry.endedAt !== "number") continue;
			if (typeof entry.cleanupCompletedAt === "number") continue;
			out.push(entry);
		}
		return out;
	};
	const refreshFrozenResultFromSession = async (sessionKey) => {
		const candidates = listPendingCompletionRunsForSession(sessionKey).filter((entry) => entry.outcome?.status !== "error");
		if (candidates.length === 0) return false;
		let captured;
		try {
			captured = await params.captureSubagentCompletionReply(sessionKey);
		} catch {
			return false;
		}
		const trimmed = captured?.trim();
		if (!trimmed || isSilentReplyText(trimmed, "NO_REPLY")) return false;
		const nextFrozen = capFrozenResultText(trimmed);
		const capturedAt = Date.now();
		let changed = false;
		for (const entry of candidates) {
			if (entry.frozenResultText === nextFrozen) continue;
			entry.frozenResultText = nextFrozen;
			entry.frozenResultCapturedAt = capturedAt;
			if (entry.pendingFinalDeliveryPayload) entry.pendingFinalDeliveryPayload = {
				...entry.pendingFinalDeliveryPayload,
				frozenResultText: nextFrozen
			};
			changed = true;
		}
		if (changed) params.persist();
		return changed;
	};
	const emitCompletionEndedHookIfNeeded = async (entry, reason) => {
		if (entry.expectsCompletionMessage === true && params.shouldEmitEndedHookForRun({
			entry,
			reason
		})) await params.emitSubagentEndedHookForRun({
			entry,
			reason,
			sendFarewell: true
		});
	};
	const clearPendingFinalDelivery = (entry) => {
		entry.pendingFinalDelivery = void 0;
		entry.pendingFinalDeliveryCreatedAt = void 0;
		entry.pendingFinalDeliveryLastAttemptAt = void 0;
		entry.pendingFinalDeliveryAttemptCount = void 0;
		entry.pendingFinalDeliveryLastError = void 0;
		entry.pendingFinalDeliveryPayload = void 0;
	};
	const loadPendingFinalDeliveryPayload = (entry) => {
		return {
			requesterSessionKey: entry.pendingFinalDeliveryPayload?.requesterSessionKey ?? entry.requesterSessionKey,
			requesterOrigin: entry.pendingFinalDeliveryPayload?.requesterOrigin ?? entry.requesterOrigin,
			requesterDisplayKey: entry.pendingFinalDeliveryPayload?.requesterDisplayKey ?? entry.requesterDisplayKey,
			childSessionKey: entry.pendingFinalDeliveryPayload?.childSessionKey ?? entry.childSessionKey,
			childRunId: entry.pendingFinalDeliveryPayload?.childRunId ?? entry.runId,
			task: entry.pendingFinalDeliveryPayload?.task ?? entry.task,
			label: entry.pendingFinalDeliveryPayload?.label ?? entry.label,
			startedAt: entry.pendingFinalDeliveryPayload?.startedAt ?? entry.startedAt,
			endedAt: entry.pendingFinalDeliveryPayload?.endedAt ?? entry.endedAt,
			outcome: entry.pendingFinalDeliveryPayload?.outcome ?? entry.outcome,
			expectsCompletionMessage: entry.pendingFinalDeliveryPayload?.expectsCompletionMessage ?? entry.expectsCompletionMessage,
			spawnMode: entry.pendingFinalDeliveryPayload?.spawnMode ?? entry.spawnMode,
			frozenResultText: entry.pendingFinalDeliveryPayload?.frozenResultText ?? entry.frozenResultText,
			fallbackFrozenResultText: entry.pendingFinalDeliveryPayload?.fallbackFrozenResultText ?? entry.fallbackFrozenResultText,
			wakeOnDescendantSettle: entry.pendingFinalDeliveryPayload?.wakeOnDescendantSettle ?? entry.wakeOnDescendantSettle
		};
	};
	const markPendingFinalDelivery = (args) => {
		const now = Date.now();
		const payload = loadPendingFinalDeliveryPayload(args.entry);
		args.entry.pendingFinalDelivery = true;
		args.entry.pendingFinalDeliveryCreatedAt ??= now;
		args.entry.pendingFinalDeliveryLastAttemptAt = now;
		args.entry.pendingFinalDeliveryAttemptCount = (args.entry.pendingFinalDeliveryAttemptCount ?? 0) + 1;
		args.entry.pendingFinalDeliveryLastError = args.error ?? null;
		args.entry.pendingFinalDeliveryPayload = payload;
	};
	const suspendPendingFinalDelivery = (args) => {
		markPendingFinalDelivery({
			entry: args.entry,
			error: args.error ?? args.entry.lastAnnounceDeliveryError ?? args.reason
		});
		const now = Date.now();
		args.entry.deliverySuspendedAt ??= now;
		args.entry.deliverySuspendedReason = args.reason;
		args.entry.cleanupHandled = false;
		args.entry.wakeOnDescendantSettle = void 0;
		args.entry.fallbackFrozenResultText = void 0;
		args.entry.fallbackFrozenResultCapturedAt = void 0;
		params.resumedRuns.delete(args.runId);
		safeSetSubagentTaskDeliveryStatus({
			runId: args.runId,
			childSessionKey: args.entry.childSessionKey,
			deliveryStatus: "failed",
			deliveryError: args.entry.lastAnnounceDeliveryError ?? args.reason
		});
		safeMarkRequiredCompletionDeliveryBlocked({
			entry: args.entry,
			reason: args.entry.lastAnnounceDeliveryError ?? args.reason
		});
		logAnnounceGiveUp(args.entry, args.reason);
		params.persist();
	};
	const shouldSuspendPendingFinalDelivery = (entry) => entry.expectsCompletionMessage === true && entry.cleanup === "keep" && entry.endedReason === "subagent-complete" && entry.outcome?.status === "ok";
	const finalizeResumedAnnounceGiveUp = async (giveUpParams) => {
		if (shouldSuspendPendingFinalDelivery(giveUpParams.entry)) {
			suspendPendingFinalDelivery({
				runId: giveUpParams.runId,
				entry: giveUpParams.entry,
				reason: giveUpParams.reason,
				error: giveUpParams.entry.lastAnnounceDeliveryError
			});
			return;
		}
		clearPendingFinalDelivery(giveUpParams.entry);
		safeSetSubagentTaskDeliveryStatus({
			runId: giveUpParams.runId,
			childSessionKey: giveUpParams.entry.childSessionKey,
			deliveryStatus: "failed",
			deliveryError: giveUpParams.entry.lastAnnounceDeliveryError
		});
		safeMarkRequiredCompletionDeliveryBlocked({
			entry: giveUpParams.entry,
			reason: giveUpParams.entry.lastAnnounceDeliveryError ?? giveUpParams.reason
		});
		giveUpParams.entry.wakeOnDescendantSettle = void 0;
		giveUpParams.entry.fallbackFrozenResultText = void 0;
		giveUpParams.entry.fallbackFrozenResultCapturedAt = void 0;
		if (giveUpParams.entry.cleanup === "delete" || !giveUpParams.entry.retainAttachmentsOnKeep) await safeRemoveAttachmentsDir(giveUpParams.entry);
		const completionReason = resolveCleanupCompletionReason(giveUpParams.entry);
		logAnnounceGiveUp(giveUpParams.entry, giveUpParams.reason);
		completeCleanupBookkeeping({
			runId: giveUpParams.runId,
			entry: giveUpParams.entry,
			cleanup: giveUpParams.entry.cleanup,
			completedAt: Date.now()
		});
		await emitCompletionEndedHookIfNeeded(giveUpParams.entry, completionReason);
	};
	const beginSubagentCleanup = (runId) => {
		const entry = params.runs.get(runId);
		if (!entry) return false;
		if (entry.cleanupCompletedAt || entry.cleanupHandled) return false;
		entry.cleanupHandled = true;
		params.persist();
		return true;
	};
	const retryDeferredCompletedAnnounces = (excludeRunId) => {
		const now = Date.now();
		for (const [runId, entry] of params.runs.entries()) {
			if (excludeRunId && runId === excludeRunId) continue;
			if (typeof entry.endedAt !== "number") continue;
			if (entry.cleanupCompletedAt || entry.cleanupHandled) continue;
			if (entry.pendingFinalDelivery === true && typeof entry.deliverySuspendedAt === "number") continue;
			if (params.suppressAnnounceForSteerRestart(entry)) continue;
			const endedAgo = now - (entry.endedAt ?? now);
			if (entry.expectsCompletionMessage !== true && endedAgo > 3e5) {
				if (!beginSubagentCleanup(runId)) continue;
				finalizeResumedAnnounceGiveUp({
					runId,
					entry,
					reason: "expiry"
				}).catch((error) => {
					defaultRuntime.log(`[warn] Subagent expiry finalize failed during deferred retry for run ${runId}: ${String(error)}`);
					const current = params.runs.get(runId);
					if (!current || current.cleanupCompletedAt) return;
					current.cleanupHandled = false;
					params.persist();
				});
				continue;
			}
			params.resumedRuns.delete(runId);
			params.resumeSubagentRun(runId);
		}
	};
	const completeCleanupBookkeeping = (cleanupParams) => {
		if (cleanupParams.entry.spawnMode !== "session") retireSessionMcpRuntimeForSessionKey({
			sessionKey: cleanupParams.entry.childSessionKey,
			reason: "subagent-run-cleanup",
			onError: (error, sessionId) => {
				params.warn("failed to retire subagent bundle MCP runtime", {
					error: buildSafeLifecycleErrorMeta(error),
					sessionId,
					runId: maskRunId(cleanupParams.runId),
					childSessionKey: maskSessionKey(cleanupParams.entry.childSessionKey)
				});
			}
		});
		if (cleanupParams.cleanup === "delete") {
			params.clearPendingLifecycleError(cleanupParams.runId);
			params.notifyContextEngineSubagentEnded({
				childSessionKey: cleanupParams.entry.childSessionKey,
				reason: "deleted",
				agentDir: cleanupParams.entry.agentDir,
				workspaceDir: cleanupParams.entry.workspaceDir
			});
			params.runs.delete(cleanupParams.runId);
			params.persist();
			retryDeferredCompletedAnnounces(cleanupParams.runId);
			return;
		}
		params.notifyContextEngineSubagentEnded({
			childSessionKey: cleanupParams.entry.childSessionKey,
			reason: "completed",
			agentDir: cleanupParams.entry.agentDir,
			workspaceDir: cleanupParams.entry.workspaceDir
		});
		cleanupParams.entry.cleanupCompletedAt = cleanupParams.completedAt;
		params.persist();
		retryDeferredCompletedAnnounces(cleanupParams.runId);
	};
	const retireRunModeBundleMcpRuntime = async (cleanupParams) => {
		if (cleanupParams.entry.spawnMode === "session") return;
		await retireSessionMcpRuntimeForSessionKey({
			sessionKey: cleanupParams.entry.childSessionKey,
			reason: cleanupParams.reason,
			onError: (error, sessionId) => {
				params.warn("failed to retire subagent bundle MCP runtime", {
					error: buildSafeLifecycleErrorMeta(error),
					sessionId,
					runId: maskRunId(cleanupParams.runId),
					childSessionKey: maskSessionKey(cleanupParams.entry.childSessionKey)
				});
			}
		});
	};
	const finalizeSubagentCleanup = async (runId, cleanup, didAnnounce, options) => {
		const entry = params.runs.get(runId);
		if (!entry) return;
		if (didAnnounce) {
			if (!options?.skipAnnounce) {
				const deliveredAt = entry.completionDeliveredAt ?? Date.now();
				entry.completionDeliveredAt = deliveredAt;
				entry.completionAnnouncedAt = deliveredAt;
				params.persist();
			}
			clearPendingFinalDelivery(entry);
			entry.deliverySuspendedAt = void 0;
			entry.deliverySuspendedReason = void 0;
			if (!options?.skipDeliveryStatus) safeSetSubagentTaskDeliveryStatus({
				runId,
				childSessionKey: entry.childSessionKey,
				deliveryStatus: "delivered"
			});
			entry.lastAnnounceDeliveryError = void 0;
			entry.lastAnnounceDropReason = void 0;
			entry.wakeOnDescendantSettle = void 0;
			entry.fallbackFrozenResultText = void 0;
			entry.fallbackFrozenResultCapturedAt = void 0;
			await emitCompletionEndedHookIfNeeded(entry, resolveCleanupCompletionReason(entry));
			if (cleanup === "delete" || !entry.retainAttachmentsOnKeep) await safeRemoveAttachmentsDir(entry);
			if (cleanup === "delete") {
				entry.frozenResultText = void 0;
				entry.frozenResultCapturedAt = void 0;
			}
			completeCleanupBookkeeping({
				runId,
				entry,
				cleanup,
				completedAt: Date.now()
			});
			return;
		}
		const now = Date.now();
		const deferredDecision = resolveDeferredCleanupDecision({
			entry,
			now,
			activeDescendantRuns: Math.max(0, params.countPendingDescendantRuns(entry.childSessionKey)),
			announceExpiryMs: ANNOUNCE_EXPIRY_MS,
			announceCompletionHardExpiryMs: ANNOUNCE_COMPLETION_HARD_EXPIRY_MS,
			maxAnnounceRetryCount: 3,
			deferDescendantDelayMs: MIN_ANNOUNCE_RETRY_DELAY_MS,
			resolveAnnounceRetryDelayMs
		});
		if (deferredDecision.kind === "defer-descendants") {
			entry.lastAnnounceRetryAt = now;
			entry.wakeOnDescendantSettle = true;
			entry.cleanupHandled = false;
			params.resumedRuns.delete(runId);
			params.persist();
			scheduleResumeSubagentRun(runId, entry, deferredDecision.delayMs);
			return;
		}
		if (deferredDecision.retryCount != null) {
			entry.announceRetryCount = deferredDecision.retryCount;
			entry.lastAnnounceRetryAt = now;
		}
		if (deferredDecision.kind === "give-up") {
			if (shouldSuspendPendingFinalDelivery(entry)) {
				suspendPendingFinalDelivery({
					runId,
					entry,
					reason: deferredDecision.reason,
					error: entry.lastAnnounceDeliveryError
				});
				return;
			}
			clearPendingFinalDelivery(entry);
			safeSetSubagentTaskDeliveryStatus({
				runId,
				childSessionKey: entry.childSessionKey,
				deliveryStatus: "failed",
				deliveryError: entry.lastAnnounceDeliveryError
			});
			safeMarkRequiredCompletionDeliveryBlocked({
				entry,
				reason: entry.lastAnnounceDeliveryError ?? deferredDecision.reason
			});
			entry.wakeOnDescendantSettle = void 0;
			entry.fallbackFrozenResultText = void 0;
			entry.fallbackFrozenResultCapturedAt = void 0;
			if (cleanup === "delete" || !entry.retainAttachmentsOnKeep) await safeRemoveAttachmentsDir(entry);
			const completionReason = resolveCleanupCompletionReason(entry);
			logAnnounceGiveUp(entry, deferredDecision.reason);
			completeCleanupBookkeeping({
				runId,
				entry,
				cleanup,
				completedAt: now
			});
			await emitCompletionEndedHookIfNeeded(entry, completionReason);
			return;
		}
		markPendingFinalDelivery({
			entry,
			error: didAnnounce ? void 0 : "announce deferred or direct delivery failed"
		});
		entry.cleanupHandled = false;
		params.resumedRuns.delete(runId);
		params.persist();
		if (deferredDecision.resumeDelayMs == null) return;
		scheduleResumeSubagentRun(runId, entry, deferredDecision.resumeDelayMs);
	};
	const startSubagentAnnounceCleanupFlow = (runId, entry) => {
		if (typeof entry.completionAnnouncedAt === "number") {
			if (!beginSubagentCleanup(runId)) return false;
			finalizeSubagentCleanup(runId, entry.cleanup, true, { skipAnnounce: true }).catch((err) => {
				defaultRuntime.log(`[warn] subagent cleanup finalize failed (${runId}): ${String(err)}`);
				const current = params.runs.get(runId);
				if (!current || current.cleanupCompletedAt) return;
				current.cleanupHandled = false;
				params.persist();
			});
			return true;
		}
		if (!beginSubagentCleanup(runId)) return false;
		if (entry.expectsCompletionMessage === false) {
			(async () => {
				if (entry.cleanup === "delete") await deleteSubagentSessionForCleanup({
					callGateway: params.callGateway,
					childSessionKey: entry.childSessionKey,
					spawnMode: entry.spawnMode,
					onError: (error) => params.warn("sessions.delete failed during subagent cleanup", {
						error: buildSafeLifecycleErrorMeta(error),
						runId: maskRunId(runId),
						childSessionKey: maskSessionKey(entry.childSessionKey)
					})
				});
				await finalizeSubagentCleanup(runId, entry.cleanup, true, {
					skipAnnounce: true,
					skipDeliveryStatus: true
				});
			})().catch((err) => {
				defaultRuntime.log(`[warn] subagent cleanup finalize failed (${runId}): ${String(err)}`);
				const current = params.runs.get(runId);
				if (!current || current.cleanupCompletedAt) return;
				current.cleanupHandled = false;
				params.persist();
			});
			return true;
		}
		const pendingPayload = loadPendingFinalDeliveryPayload(entry);
		const requesterOrigin = normalizeDeliveryContext(pendingPayload.requesterOrigin);
		let latestDeliveryError = entry.lastAnnounceDeliveryError;
		const finalizeAnnounceCleanup = async (didAnnounce) => {
			const shouldCreditPriorDelivery = !didAnnounce && await hasPriorRequesterDeliveryMirror(entry);
			if (shouldCreditPriorDelivery) latestDeliveryError = void 0;
			if (!didAnnounce && latestDeliveryError) entry.lastAnnounceDeliveryError = latestDeliveryError;
			finalizeSubagentCleanup(runId, entry.cleanup, didAnnounce || shouldCreditPriorDelivery).catch((err) => {
				defaultRuntime.log(`[warn] subagent cleanup finalize failed (${runId}): ${String(err)}`);
				const current = params.runs.get(runId);
				if (!current || current.cleanupCompletedAt) return;
				current.cleanupHandled = false;
				params.persist();
			});
		};
		params.runSubagentAnnounceFlow({
			childSessionKey: pendingPayload.childSessionKey,
			childRunId: pendingPayload.childRunId,
			requesterSessionKey: pendingPayload.requesterSessionKey,
			requesterOrigin,
			requesterDisplayKey: pendingPayload.requesterDisplayKey,
			task: pendingPayload.task,
			timeoutMs: params.subagentAnnounceTimeoutMs,
			cleanup: entry.cleanup,
			roundOneReply: pendingPayload.frozenResultText ?? void 0,
			fallbackReply: pendingPayload.fallbackFrozenResultText ?? void 0,
			waitForCompletion: false,
			startedAt: pendingPayload.startedAt,
			endedAt: pendingPayload.endedAt,
			label: pendingPayload.label,
			outcome: pendingPayload.outcome,
			spawnMode: pendingPayload.spawnMode,
			expectsCompletionMessage: pendingPayload.expectsCompletionMessage,
			wakeOnDescendantSettle: pendingPayload.wakeOnDescendantSettle === true,
			onDeliveryResult: (delivery) => {
				recordAnnounceDeliveryResult(entry, delivery);
				if (delivery.delivered) {
					if (entry.lastAnnounceDeliveryError !== void 0) {
						entry.lastAnnounceDeliveryError = void 0;
						params.persist();
					}
					latestDeliveryError = void 0;
					return;
				}
				if (delivery.path === "none") entry.lastAnnounceDropReason = "sink_unavailable";
				latestDeliveryError = formatAnnounceDeliveryError(delivery);
				if (entry.lastAnnounceDeliveryError !== latestDeliveryError) {
					entry.lastAnnounceDeliveryError = latestDeliveryError;
					params.persist();
				}
			}
		}).then((didAnnounce) => {
			finalizeAnnounceCleanup(didAnnounce);
		}).catch((error) => {
			defaultRuntime.log(`[warn] Subagent announce flow failed during cleanup for run ${runId}: ${String(error)}`);
			finalizeAnnounceCleanup(false);
		});
		return true;
	};
	const completeSubagentRun = async (completeParams) => {
		params.clearPendingLifecycleError(completeParams.runId);
		const entry = params.runs.get(completeParams.runId);
		if (!entry) return;
		let mutated = false;
		if (completeParams.reason === "subagent-complete" && entry.suppressAnnounceReason === "killed" && (entry.cleanupHandled || typeof entry.cleanupCompletedAt === "number")) {
			entry.suppressAnnounceReason = void 0;
			entry.cleanupHandled = false;
			entry.cleanupCompletedAt = void 0;
			entry.completionAnnouncedAt = void 0;
			mutated = true;
		}
		const endedAt = typeof completeParams.endedAt === "number" ? completeParams.endedAt : Date.now();
		if (entry.endedAt !== endedAt) {
			entry.endedAt = endedAt;
			mutated = true;
		}
		const outcome = withSubagentOutcomeTiming(completeParams.outcome, {
			startedAt: entry.startedAt,
			endedAt
		});
		if (shouldUpdateRunOutcome(entry.outcome, outcome)) {
			entry.outcome = outcome;
			mutated = true;
		}
		if (entry.endedReason !== completeParams.reason) {
			entry.endedReason = completeParams.reason;
			mutated = true;
		}
		if (entry.pauseReason !== void 0) {
			entry.pauseReason = void 0;
			mutated = true;
		}
		if (await freezeRunResultAtCompletion(entry, outcome)) mutated = true;
		if (mutated) params.persist();
		safeFinalizeSubagentTaskRun({
			entry,
			outcome
		});
		try {
			await persistSubagentSessionTiming(entry);
		} catch (err) {
			params.warn("failed to persist subagent session timing", {
				err,
				runId: entry.runId,
				childSessionKey: entry.childSessionKey
			});
		}
		const suppressedForSteerRestart = params.suppressAnnounceForSteerRestart(entry);
		if (mutated && !suppressedForSteerRestart) emitSessionLifecycleEvent({
			sessionKey: entry.childSessionKey,
			reason: "subagent-status",
			parentSessionKey: entry.requesterSessionKey,
			label: entry.label
		});
		const shouldEmitEndedHook = !suppressedForSteerRestart && params.shouldEmitEndedHookForRun({
			entry,
			reason: completeParams.reason
		});
		if (!(shouldEmitEndedHook && completeParams.triggerCleanup && entry.expectsCompletionMessage === true && !suppressedForSteerRestart) && shouldEmitEndedHook) await params.emitSubagentEndedHookForRun({
			entry,
			reason: completeParams.reason,
			sendFarewell: completeParams.sendFarewell,
			accountId: completeParams.accountId
		});
		if (!completeParams.triggerCleanup || suppressedForSteerRestart) return;
		try {
			await (params.cleanupBrowserSessionsForLifecycleEnd ?? await loadCleanupBrowserSessionsForLifecycleEnd$1())({
				sessionKeys: [entry.childSessionKey],
				onWarn: (msg) => params.warn(msg, { runId: entry.runId })
			});
		} catch (error) {
			params.warn("failed to cleanup browser sessions for completed subagent", {
				error: buildSafeLifecycleErrorMeta(error),
				runId: maskRunId(completeParams.runId),
				childSessionKey: maskSessionKey(entry.childSessionKey)
			});
		}
		try {
			await retireRunModeBundleMcpRuntime({
				runId: completeParams.runId,
				entry,
				reason: "subagent-run-complete"
			});
		} catch (error) {
			params.warn("failed to retire subagent bundle MCP runtime after completion", {
				error: buildSafeLifecycleErrorMeta(error),
				runId: maskRunId(completeParams.runId),
				childSessionKey: maskSessionKey(entry.childSessionKey)
			});
		}
		startSubagentAnnounceCleanupFlow(completeParams.runId, entry);
	};
	return {
		clearScheduledResumeTimers,
		completeCleanupBookkeeping,
		completeSubagentRun,
		finalizeResumedAnnounceGiveUp,
		refreshFrozenResultFromSession,
		startSubagentAnnounceCleanupFlow
	};
}
//#endregion
//#region src/agents/subagent-registry-run-manager.ts
const log$1 = createSubsystemLogger("agents/subagent-registry");
const RECOVERABLE_WAIT_RETRY_DELAY_MS = process.env.OPENCLAW_TEST_FAST === "1" ? 25 : 5e3;
function shouldDeleteAttachments(entry) {
	return entry.cleanup === "delete" || !entry.retainAttachmentsOnKeep;
}
function markSubagentRunPausedAfterYield(params) {
	const { entry } = params;
	let mutated = false;
	if (typeof params.startedAt === "number" && entry.startedAt !== params.startedAt) {
		entry.startedAt = params.startedAt;
		if (typeof entry.sessionStartedAt !== "number") entry.sessionStartedAt = params.startedAt;
		mutated = true;
	}
	const endedAt = typeof params.endedAt === "number" ? params.endedAt : params.now ?? Date.now();
	if (entry.endedAt !== endedAt) {
		entry.endedAt = endedAt;
		mutated = true;
	}
	if (entry.pauseReason !== "sessions_yield") {
		entry.pauseReason = "sessions_yield";
		mutated = true;
	}
	if (entry.outcome !== void 0) {
		entry.outcome = void 0;
		mutated = true;
	}
	if (entry.endedReason !== void 0) {
		entry.endedReason = void 0;
		mutated = true;
	}
	if (entry.cleanupHandled === true) {
		entry.cleanupHandled = false;
		mutated = true;
	}
	if (entry.frozenResultText !== void 0) {
		entry.frozenResultText = void 0;
		entry.frozenResultCapturedAt = void 0;
		mutated = true;
	}
	return mutated;
}
function createSubagentRunManager(params) {
	const waitForSubagentCompletion = async (runId, waitTimeoutMs, expectedEntry) => {
		let completionForRetry;
		const scheduleWaitRetry = (entry, reason, error) => {
			params.scheduleOrphanRecovery({ delayMs: 1e3 });
			const scheduledEntry = entry;
			setTimeout(() => {
				const current = params.runs.get(runId);
				if (!current || current !== scheduledEntry || typeof current.endedAt === "number") return;
				waitForSubagentCompletion(runId, waitTimeoutMs, scheduledEntry);
			}, RECOVERABLE_WAIT_RETRY_DELAY_MS).unref?.();
			log$1.info(reason, {
				runId,
				childSessionKey: entry.childSessionKey,
				...error ? { error } : {}
			});
		};
		try {
			const wait = await waitForAgentRun({
				runId,
				timeoutMs: Math.max(1, Math.floor(waitTimeoutMs)),
				callGateway: params.callGateway
			});
			const entry = params.runs.get(runId);
			if (!entry || expectedEntry && entry !== expectedEntry) return;
			if (wait.status === "pending") return;
			const waitBlocked = isBlockedLivenessState(wait.livenessState);
			if (wait.yielded === true && !waitBlocked) {
				if (markSubagentRunPausedAfterYield({
					entry,
					startedAt: wait.startedAt,
					endedAt: wait.endedAt
				})) params.persist();
				return;
			}
			const waitStatus = waitBlocked ? "error" : wait.status;
			if (waitStatus === "error" && isRecoverableAgentWaitError(wait.error)) {
				scheduleWaitRetry(entry, "subagent wait interrupted; scheduling recovery", wait.error);
				return;
			}
			if (waitStatus === "timeout") {
				const isTerminalWaitTimeout = typeof wait.endedAt === "number" || typeof wait.stopReason === "string" || typeof wait.livenessState === "string";
				const completion = params.resolveSubagentSessionCompletion({
					childSessionKey: entry.childSessionKey,
					fallbackEndedAt: typeof wait.endedAt === "number" ? wait.endedAt : Date.now(),
					notBeforeMs: entry.startedAt ?? entry.createdAt
				});
				if (completion) {
					completionForRetry = {
						runId,
						endedAt: completion.endedAt,
						outcome: completion.outcome,
						reason: completion.reason,
						sendFarewell: true,
						accountId: entry.requesterOrigin?.accountId,
						triggerCleanup: true
					};
					await params.completeSubagentRun(completionForRetry);
					return;
				}
				if (isTerminalWaitTimeout) {
					completionForRetry = {
						runId,
						endedAt: wait.endedAt,
						outcome: { status: "timeout" },
						reason: SUBAGENT_ENDED_REASON_COMPLETE,
						sendFarewell: true,
						accountId: entry.requesterOrigin?.accountId,
						triggerCleanup: true
					};
					await params.completeSubagentRun(completionForRetry);
					return;
				}
				scheduleWaitRetry(entry, "subagent wait timed out; deferring terminal state until session reconciliation");
				return;
			}
			let mutated = false;
			if (typeof wait.startedAt === "number") {
				entry.startedAt = wait.startedAt;
				if (typeof entry.sessionStartedAt !== "number") entry.sessionStartedAt = wait.startedAt;
				mutated = true;
			}
			if (typeof wait.endedAt === "number") {
				entry.endedAt = wait.endedAt;
				mutated = true;
			}
			if (!entry.endedAt) {
				entry.endedAt = Date.now();
				mutated = true;
			}
			const rawWaitError = typeof wait.error === "string" ? wait.error : void 0;
			const waitError = waitBlocked ? formatBlockedLivenessError(rawWaitError) : rawWaitError;
			const outcome = withSubagentOutcomeTiming(waitStatus === "error" ? {
				status: "error",
				error: waitError
			} : { status: "ok" }, {
				startedAt: entry.startedAt,
				endedAt: entry.endedAt
			});
			if (shouldUpdateRunOutcome(entry.outcome, outcome)) {
				entry.outcome = outcome;
				mutated = true;
			}
			if (mutated) params.persist();
			completionForRetry = {
				runId,
				endedAt: entry.endedAt,
				outcome,
				reason: waitStatus === "error" ? SUBAGENT_ENDED_REASON_ERROR : SUBAGENT_ENDED_REASON_COMPLETE,
				sendFarewell: true,
				accountId: entry.requesterOrigin?.accountId,
				triggerCleanup: true
			};
			await params.completeSubagentRun(completionForRetry);
		} catch (error) {
			const current = params.runs.get(runId);
			log$1.warn("failed to complete subagent run; retrying completion", {
				runId,
				childSessionKey: current?.childSessionKey ?? expectedEntry?.childSessionKey,
				error
			});
			if (current && typeof current.endedAt === "number" && !current.cleanupCompletedAt && current.pauseReason !== "sessions_yield") {
				if (completionForRetry) try {
					await params.completeSubagentRun(completionForRetry);
					return;
				} catch (retryError) {
					log$1.warn("failed to complete subagent run after retry; retrying ended cleanup", {
						runId,
						childSessionKey: current.childSessionKey,
						error: retryError
					});
				}
				current.cleanupHandled = false;
				params.resumedRuns.delete(runId);
				params.resumeSubagentRun(runId);
			}
		}
	};
	const markSubagentRunForSteerRestart = (runId) => {
		const key = runId.trim();
		if (!key) return false;
		const entry = params.runs.get(key);
		if (!entry) return false;
		if (entry.suppressAnnounceReason === "steer-restart") return true;
		entry.suppressAnnounceReason = "steer-restart";
		params.persist();
		return true;
	};
	const clearSubagentRunSteerRestart = (runId) => {
		const key = runId.trim();
		if (!key) return false;
		const entry = params.runs.get(key);
		if (!entry) return false;
		if (entry.suppressAnnounceReason !== "steer-restart") return true;
		entry.suppressAnnounceReason = void 0;
		params.persist();
		params.resumedRuns.delete(key);
		if (typeof entry.endedAt === "number" && !entry.cleanupCompletedAt) params.resumeSubagentRun(key);
		return true;
	};
	const replaceSubagentRunAfterSteer = (replaceParams) => {
		const previousRunId = replaceParams.previousRunId.trim();
		const nextRunId = replaceParams.nextRunId.trim();
		if (!previousRunId || !nextRunId) return false;
		const source = params.runs.get(previousRunId) ?? replaceParams.fallback;
		if (!source) return false;
		if (previousRunId !== nextRunId) {
			params.clearPendingLifecycleError(previousRunId);
			if (shouldDeleteAttachments(source)) safeRemoveAttachmentsDir(source);
			params.runs.delete(previousRunId);
			params.resumedRuns.delete(previousRunId);
		}
		const now = Date.now();
		const cfg = params.getRuntimeConfig();
		const archiveAfterMs = resolveArchiveAfterMs(cfg);
		const spawnMode = source.spawnMode === "session" ? "session" : "run";
		const archiveAtMs = spawnMode === "session" || source.cleanup === "keep" ? void 0 : archiveAfterMs ? now + archiveAfterMs : void 0;
		const runTimeoutSeconds = replaceParams.runTimeoutSeconds ?? source.runTimeoutSeconds ?? 0;
		const waitTimeoutMs = params.resolveSubagentWaitTimeoutMs(cfg, runTimeoutSeconds);
		const preserveFrozenResultFallback = replaceParams.preserveFrozenResultFallback === true;
		const sessionStartedAt = getSubagentSessionStartedAt(source) ?? now;
		const accumulatedRuntimeMs = getSubagentSessionRuntimeMs(source, typeof source.endedAt === "number" ? source.endedAt : now) ?? 0;
		const next = {
			...source,
			runId: nextRunId,
			createdAt: now,
			startedAt: now,
			sessionStartedAt,
			accumulatedRuntimeMs,
			endedAt: void 0,
			endedReason: void 0,
			pauseReason: void 0,
			endedHookEmittedAt: void 0,
			wakeOnDescendantSettle: void 0,
			outcome: void 0,
			frozenResultText: void 0,
			frozenResultCapturedAt: void 0,
			fallbackFrozenResultText: preserveFrozenResultFallback ? source.frozenResultText : void 0,
			fallbackFrozenResultCapturedAt: preserveFrozenResultFallback ? source.frozenResultCapturedAt : void 0,
			cleanupCompletedAt: void 0,
			cleanupHandled: false,
			completionEnqueuedAt: void 0,
			completionDeliveredAt: void 0,
			completionAnnouncedAt: void 0,
			lastAnnounceDropReason: void 0,
			suppressAnnounceReason: void 0,
			announceRetryCount: void 0,
			lastAnnounceRetryAt: void 0,
			lastAnnounceDeliveryError: void 0,
			pendingFinalDelivery: void 0,
			pendingFinalDeliveryCreatedAt: void 0,
			pendingFinalDeliveryLastAttemptAt: void 0,
			pendingFinalDeliveryAttemptCount: void 0,
			pendingFinalDeliveryLastError: void 0,
			pendingFinalDeliveryPayload: void 0,
			deliverySuspendedAt: void 0,
			deliverySuspendedReason: void 0,
			deliveryDiscardedAt: void 0,
			deliveryDiscardReason: void 0,
			deliveryDiscardedPayloadSummary: void 0,
			spawnMode,
			archiveAtMs,
			runTimeoutSeconds
		};
		params.runs.set(nextRunId, next);
		params.ensureListener();
		params.persist();
		params.startSweeper();
		waitForSubagentCompletion(nextRunId, waitTimeoutMs, next);
		return true;
	};
	const registerSubagentRun = (registerParams) => {
		const runId = registerParams.runId.trim();
		const childSessionKey = registerParams.childSessionKey.trim();
		const requesterSessionKey = registerParams.requesterSessionKey.trim();
		const controllerSessionKey = registerParams.controllerSessionKey?.trim() || requesterSessionKey;
		if (!runId || !childSessionKey || !requesterSessionKey) return;
		const now = Date.now();
		const cfg = params.getRuntimeConfig();
		const archiveAfterMs = resolveArchiveAfterMs(cfg);
		const spawnMode = registerParams.spawnMode === "session" ? "session" : "run";
		const archiveAtMs = spawnMode === "session" || registerParams.cleanup === "keep" ? void 0 : archiveAfterMs ? now + archiveAfterMs : void 0;
		const runTimeoutSeconds = registerParams.runTimeoutSeconds ?? 0;
		const waitTimeoutMs = params.resolveSubagentWaitTimeoutMs(cfg, runTimeoutSeconds);
		const requesterOrigin = normalizeDeliveryContext(registerParams.requesterOrigin);
		const entry = {
			runId,
			childSessionKey,
			controllerSessionKey,
			requesterSessionKey,
			requesterOrigin,
			requesterDisplayKey: registerParams.requesterDisplayKey,
			task: registerParams.task,
			taskName: registerParams.taskName,
			cleanup: registerParams.cleanup,
			expectsCompletionMessage: registerParams.expectsCompletionMessage,
			spawnMode,
			label: registerParams.label,
			model: registerParams.model,
			agentDir: registerParams.agentDir,
			workspaceDir: registerParams.workspaceDir,
			runTimeoutSeconds,
			createdAt: now,
			startedAt: now,
			sessionStartedAt: now,
			accumulatedRuntimeMs: 0,
			archiveAtMs,
			cleanupHandled: false,
			completionAnnouncedAt: void 0,
			wakeOnDescendantSettle: void 0,
			attachmentsDir: registerParams.attachmentsDir,
			attachmentsRootDir: registerParams.attachmentsRootDir,
			retainAttachmentsOnKeep: registerParams.retainAttachmentsOnKeep
		};
		params.runs.set(runId, entry);
		try {
			params.persistOrThrow();
		} catch (error) {
			params.runs.delete(runId);
			throw error;
		}
		try {
			createRunningTaskRun({
				runtime: "subagent",
				sourceId: runId,
				ownerKey: requesterSessionKey,
				scopeKind: "session",
				requesterOrigin,
				childSessionKey,
				runId,
				label: registerParams.label,
				task: registerParams.task,
				deliveryStatus: registerParams.expectsCompletionMessage === false ? "not_applicable" : "pending",
				startedAt: now,
				lastEventAt: now
			});
		} catch (error) {
			log$1.warn("Failed to create background task for subagent run", {
				runId: registerParams.runId,
				error
			});
		}
		params.ensureListener();
		params.persist();
		params.startSweeper();
		waitForSubagentCompletion(runId, waitTimeoutMs, entry);
	};
	const releaseSubagentRun = (runId) => {
		params.clearPendingLifecycleError(runId);
		const entry = params.runs.get(runId);
		if (entry) {
			if (shouldDeleteAttachments(entry)) safeRemoveAttachmentsDir(entry);
			params.notifyContextEngineSubagentEnded({
				childSessionKey: entry.childSessionKey,
				reason: "released",
				agentDir: entry.agentDir,
				workspaceDir: entry.workspaceDir
			});
		}
		if (params.runs.delete(runId)) params.persist();
		if (params.runs.size === 0) params.stopSweeper();
	};
	const markSubagentRunTerminated = (markParams) => {
		const runIds = /* @__PURE__ */ new Set();
		if (typeof markParams.runId === "string" && markParams.runId.trim()) runIds.add(markParams.runId.trim());
		if (typeof markParams.childSessionKey === "string" && markParams.childSessionKey.trim()) {
			for (const [runId, entry] of params.runs.entries()) if (entry.childSessionKey === markParams.childSessionKey.trim()) runIds.add(runId);
		}
		if (runIds.size === 0) return 0;
		const now = Date.now();
		const reason = markParams.reason?.trim() || "killed";
		let updated = 0;
		const entriesByChildSessionKey = /* @__PURE__ */ new Map();
		for (const runId of runIds) {
			params.clearPendingLifecycleError(runId);
			const entry = params.runs.get(runId);
			if (!entry) continue;
			if (typeof entry.endedAt === "number") continue;
			entry.endedAt = now;
			entry.outcome = withSubagentOutcomeTiming({
				status: "error",
				error: reason
			}, {
				startedAt: entry.startedAt,
				endedAt: now
			});
			entry.endedReason = SUBAGENT_ENDED_REASON_KILLED;
			entry.cleanupHandled = true;
			entry.cleanupCompletedAt = now;
			entry.suppressAnnounceReason = "killed";
			if (!entriesByChildSessionKey.has(entry.childSessionKey)) entriesByChildSessionKey.set(entry.childSessionKey, entry);
			updated += 1;
		}
		if (updated > 0) {
			params.persist();
			for (const entry of entriesByChildSessionKey.values()) {
				const emitEndedHook = () => emitSubagentEndedHookOnce({
					entry,
					reason: SUBAGENT_ENDED_REASON_KILLED,
					sendFarewell: true,
					accountId: entry.requesterOrigin?.accountId,
					outcome: SUBAGENT_ENDED_OUTCOME_KILLED,
					error: reason,
					inFlightRunIds: params.endedHookInFlightRunIds,
					persist: () => params.persist()
				});
				persistSubagentSessionTiming(entry).catch((err) => {
					log$1.warn("failed to persist killed subagent session timing", {
						err,
						runId: entry.runId,
						childSessionKey: entry.childSessionKey
					});
				});
				if (shouldDeleteAttachments(entry)) safeRemoveAttachmentsDir(entry);
				params.completeCleanupBookkeeping({
					runId: entry.runId,
					entry,
					cleanup: entry.cleanup,
					completedAt: now
				});
				if (getGlobalHookRunner()) {
					emitEndedHook().catch(() => {});
					continue;
				}
				const cfg = params.getRuntimeConfig();
				Promise.resolve(params.ensureRuntimePluginsLoaded({
					config: cfg,
					workspaceDir: entry.workspaceDir,
					allowGatewaySubagentBinding: true
				})).then(emitEndedHook).catch(() => {});
			}
		}
		return updated;
	};
	return {
		clearSubagentRunSteerRestart,
		markSubagentRunForSteerRestart,
		markSubagentRunTerminated,
		registerSubagentRun,
		releaseSubagentRun,
		replaceSubagentRunAfterSteer,
		waitForSubagentCompletion
	};
}
//#endregion
//#region src/agents/subagent-session-reconciliation.ts
function finiteTimestamp(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function terminalSessionTimestamp(sessionEntry) {
	return finiteTimestamp(sessionEntry?.endedAt) ?? finiteTimestamp(sessionEntry?.updatedAt);
}
function isFreshForRun(sessionEntry, notBeforeMs) {
	if (notBeforeMs === void 0) return true;
	const terminalAt = terminalSessionTimestamp(sessionEntry);
	return terminalAt !== void 0 && terminalAt >= notBeforeMs;
}
function findSessionEntryByKey(store, sessionKey) {
	const direct = store[sessionKey];
	if (direct) return direct;
	const normalized = sessionKey.trim().toLowerCase();
	for (const [key, entry] of Object.entries(store)) if (key.trim().toLowerCase() === normalized) return entry;
}
function loadSubagentSessionEntry(params) {
	const key = params.childSessionKey.trim();
	if (!key) return;
	const agentId = resolveAgentIdFromSessionKey(key);
	const storePath = resolveStorePath((params.cfg ?? getRuntimeConfig()).session?.store, { agentId });
	let store = params.storeCache?.get(storePath);
	if (!store) {
		store = loadSessionStore(storePath);
		params.storeCache?.set(storePath, store);
	}
	return findSessionEntryByKey(store, key);
}
function resolveCompletionFromSessionEntry(sessionEntry, fallbackEndedAt, opts) {
	const status = sessionEntry?.status;
	const endedAt = finiteTimestamp(sessionEntry?.endedAt) ?? finiteTimestamp(sessionEntry?.updatedAt) ?? fallbackEndedAt;
	if (status === "done") {
		if (!isFreshForRun(sessionEntry, opts?.notBeforeMs)) return null;
		return {
			endedAt,
			outcome: { status: "ok" },
			reason: SUBAGENT_ENDED_REASON_COMPLETE
		};
	}
	if (status === "timeout") {
		if (!isFreshForRun(sessionEntry, opts?.notBeforeMs)) return null;
		return {
			endedAt,
			outcome: { status: "timeout" },
			reason: SUBAGENT_ENDED_REASON_COMPLETE
		};
	}
	if (status === "failed") {
		if (!isFreshForRun(sessionEntry, opts?.notBeforeMs)) return null;
		return {
			endedAt,
			outcome: {
				status: "error",
				error: "session completed before registry settled"
			},
			reason: SUBAGENT_ENDED_REASON_ERROR
		};
	}
	if (status === "killed") {
		if (!isFreshForRun(sessionEntry, opts?.notBeforeMs)) return null;
		return {
			endedAt,
			outcome: {
				status: "error",
				error: "subagent run terminated"
			},
			reason: SUBAGENT_ENDED_REASON_KILLED
		};
	}
	if (status !== "running" && typeof sessionEntry?.endedAt === "number") {
		if (!isFreshForRun(sessionEntry, opts?.notBeforeMs)) return null;
		return {
			endedAt,
			outcome: { status: "ok" },
			reason: SUBAGENT_ENDED_REASON_COMPLETE
		};
	}
	return null;
}
function resolveSubagentSessionCompletion(params) {
	return resolveCompletionFromSessionEntry(loadSubagentSessionEntry({
		childSessionKey: params.childSessionKey,
		storeCache: params.storeCache,
		cfg: params.cfg
	}), params.fallbackEndedAt, { notBeforeMs: params.notBeforeMs });
}
//#endregion
//#region src/agents/subagent-registry-maintenance.ts
function isCleanupCompleteForMaintenance(entry) {
	return typeof entry.cleanupCompletedAt === "number";
}
function isActiveForMaintenance(entry) {
	return typeof entry.endedAt !== "number";
}
function isPendingFinalDeliveryForMaintenance(entry) {
	return entry.pendingFinalDelivery === true;
}
function isAwaitingCompletionAnnounceForMaintenance(entry) {
	return entry.expectsCompletionMessage === true && typeof entry.completionAnnouncedAt !== "number";
}
function shouldPreserveForMaintenance(entry) {
	if (isCleanupCompleteForMaintenance(entry)) return false;
	if (isActiveForMaintenance(entry)) return true;
	return isAwaitingCompletionAnnounceForMaintenance(entry) || isPendingFinalDeliveryForMaintenance(entry);
}
function listSessionMaintenanceProtectedSubagentSessionKeys() {
	const keys = /* @__PURE__ */ new Set();
	for (const entry of getSubagentRunsSnapshotForRead(subagentRuns).values()) {
		if (!shouldPreserveForMaintenance(entry)) continue;
		const childSessionKey = entry.childSessionKey.trim();
		if (childSessionKey) keys.add(childSessionKey);
	}
	return [...keys];
}
registerSessionMaintenancePreserveKeysProvider(listSessionMaintenanceProtectedSubagentSessionKeys);
//#endregion
//#region src/agents/subagent-registry.ts
const log = createSubsystemLogger("agents/subagent-registry");
const subagentAnnounceLoader = createLazyImportLoader(() => import("./subagent-announce-BdzYTdKs.js"));
const browserCleanupLoader = createLazyImportLoader(() => import("./browser-lifecycle-cleanup-CbRipfw2.js"));
async function loadSubagentAnnounceModule() {
	return await subagentAnnounceLoader.load();
}
async function loadCleanupBrowserSessionsForLifecycleEnd() {
	return (await browserCleanupLoader.load()).cleanupBrowserSessionsForLifecycleEnd;
}
let subagentRegistryDeps = {
	callGateway,
	captureSubagentCompletionReply: async (sessionKey, options) => (await loadSubagentAnnounceModule()).captureSubagentCompletionReply(sessionKey, options),
	cleanupBrowserSessionsForLifecycleEnd: async (params) => (await loadCleanupBrowserSessionsForLifecycleEnd())(params),
	getSubagentRunsSnapshotForRead,
	getRuntimeConfig,
	onAgentEvent,
	persistSubagentRunsToDisk,
	persistSubagentRunsToDiskOrThrow,
	resolveAgentTimeoutMs,
	restoreSubagentRunsFromDisk,
	runSubagentAnnounceFlow: async (params) => (await loadSubagentAnnounceModule()).runSubagentAnnounceFlow(params)
};
const SUBAGENT_REGISTRY_RUNTIME_SPEC = ["./subagent-registry.runtime", ".js"];
const contextEngineInitLoader = createLazyPromiseLoader(() => importRuntimeModule(import.meta.url, SUBAGENT_REGISTRY_RUNTIME_SPEC));
const contextEngineRegistryLoader = createLazyPromiseLoader(() => importRuntimeModule(import.meta.url, SUBAGENT_REGISTRY_RUNTIME_SPEC));
const runtimePluginsLoader = createLazyPromiseLoader(() => importRuntimeModule(import.meta.url, SUBAGENT_REGISTRY_RUNTIME_SPEC));
let sweeper = null;
const resumeRetryTimers = /* @__PURE__ */ new Set();
let sweepInProgress = false;
let listenerStarted = false;
let restoreAttempted = false;
const ORPHAN_RECOVERY_DEBOUNCE_MS = 1e3;
let lastOrphanRecoveryScheduleAt = 0;
const SUBAGENT_ANNOUNCE_TIMEOUT_MS = 12e4;
/**
* Embedded runs can emit transient lifecycle `error` events while provider/model
* retry is still in progress. Defer terminal error cleanup briefly so a
* subsequent lifecycle `start` / `end` can cancel premature failure announces.
*/
const LIFECYCLE_ERROR_RETRY_GRACE_MS = 15e3;
/**
* Embedded runs can also surface an intermediate lifecycle `end` with
* `aborted=true` just before the runtime automatically retries the same run.
* Give that timeout a short grace window so the parent does not get a stale
* `timed out` completion right before the eventual success.
*/
const LIFECYCLE_TIMEOUT_RETRY_GRACE_MS = 15e3;
/** Absolute TTL for session-mode runs after cleanup completes (no archiveAtMs). */
const SESSION_RUN_TTL_MS = 5 * 6e4;
/** Absolute TTL for orphaned pendingLifecycleError / pendingLifecycleTimeout entries. */
const PENDING_LIFECYCLE_TERMINAL_TTL_MS = 5 * 6e4;
/** Grace period before treating a "running" subagent without a live run context as stale. */
const STALE_ACTIVE_SUBAGENT_GRACE_MS = process.env.OPENCLAW_TEST_FAST === "1" ? 1e3 : 6e4;
const SUSPENDED_DELIVERY_CRON_EXPIRY_MS = 120 * 6e4;
const SUSPENDED_DELIVERY_SUBAGENT_EXPIRY_MS = 360 * 6e4;
const SUSPENDED_DELIVERY_INTERACTIVE_EXPIRY_MS = 1440 * 6e4;
const SUSPENDED_DELIVERY_SOFT_CAP = 25;
const SUSPENDED_DELIVERY_HARD_CAP = 50;
const SUSPENDED_DELIVERY_PRESSURE_TARGET = 10;
function loadContextEngineInitModule() {
	return contextEngineInitLoader.load();
}
function loadContextEngineRegistryModule() {
	return contextEngineRegistryLoader.load();
}
function loadRuntimePluginsModule() {
	return runtimePluginsLoader.load();
}
async function ensureSubagentRegistryPluginRuntimeLoaded(params) {
	const ensureRuntimePluginsLoaded = subagentRegistryDeps.ensureRuntimePluginsLoaded;
	if (ensureRuntimePluginsLoaded) {
		ensureRuntimePluginsLoaded(params);
		return;
	}
	(await loadRuntimePluginsModule()).ensureRuntimePluginsLoaded(params);
}
async function resolveSubagentRegistryContextEngine(cfg, options) {
	const initModule = await loadContextEngineInitModule();
	const registryModule = await loadContextEngineRegistryModule();
	const ensureContextEnginesInitialized = subagentRegistryDeps.ensureContextEnginesInitialized ?? initModule.ensureContextEnginesInitialized;
	const resolveContextEngine = subagentRegistryDeps.resolveContextEngine ?? registryModule.resolveContextEngine;
	ensureContextEnginesInitialized();
	return await resolveContextEngine(cfg, options);
}
function persistSubagentRuns() {
	subagentRegistryDeps.persistSubagentRunsToDisk(subagentRuns);
}
function persistSubagentRunsOrThrow() {
	subagentRegistryDeps.persistSubagentRunsToDiskOrThrow(subagentRuns);
}
function scheduleSubagentOrphanRecovery(params) {
	const now = Date.now();
	if (now - lastOrphanRecoveryScheduleAt < ORPHAN_RECOVERY_DEBOUNCE_MS) return;
	lastOrphanRecoveryScheduleAt = now;
	import("./subagent-orphan-recovery-mfkry_Cm.js").then(({ scheduleOrphanRecovery }) => {
		scheduleOrphanRecovery({
			getActiveRuns: () => subagentRuns,
			delayMs: params?.delayMs,
			maxRetries: params?.maxRetries
		});
	}, () => {});
}
const resumedRuns = /* @__PURE__ */ new Set();
const endedHookInFlightRunIds = /* @__PURE__ */ new Set();
const pendingLifecycleErrorByRunId = /* @__PURE__ */ new Map();
const pendingLifecycleTimeoutByRunId = /* @__PURE__ */ new Map();
function clearPendingLifecycleError(runId) {
	const pending = pendingLifecycleErrorByRunId.get(runId);
	if (!pending) return;
	clearTimeout(pending.timer);
	pendingLifecycleErrorByRunId.delete(runId);
}
function clearPendingLifecycleTimeout(runId) {
	const pending = pendingLifecycleTimeoutByRunId.get(runId);
	if (!pending) return;
	clearTimeout(pending.timer);
	pendingLifecycleTimeoutByRunId.delete(runId);
}
function schedulePendingLifecycleError(params) {
	clearPendingLifecycleTimeout(params.runId);
	clearPendingLifecycleError(params.runId);
	const timer = setTimeout(() => {
		const pending = pendingLifecycleErrorByRunId.get(params.runId);
		if (!pending || pending.timer !== timer) return;
		pendingLifecycleErrorByRunId.delete(params.runId);
		const entry = subagentRuns.get(params.runId);
		if (!entry) return;
		if (entry.endedReason === "subagent-complete" || entry.outcome?.status === "ok") return;
		completeSubagentRun({
			runId: params.runId,
			endedAt: pending.endedAt,
			outcome: {
				status: "error",
				error: pending.error
			},
			reason: SUBAGENT_ENDED_REASON_ERROR,
			sendFarewell: true,
			accountId: entry.requesterOrigin?.accountId,
			triggerCleanup: true
		});
	}, LIFECYCLE_ERROR_RETRY_GRACE_MS);
	timer.unref?.();
	pendingLifecycleErrorByRunId.set(params.runId, {
		timer,
		endedAt: params.endedAt,
		error: params.error
	});
}
function schedulePendingLifecycleTimeout(params) {
	clearPendingLifecycleError(params.runId);
	clearPendingLifecycleTimeout(params.runId);
	const timer = setTimeout(() => {
		const pending = pendingLifecycleTimeoutByRunId.get(params.runId);
		if (!pending || pending.timer !== timer) return;
		pendingLifecycleTimeoutByRunId.delete(params.runId);
		const entry = subagentRuns.get(params.runId);
		if (!entry) return;
		if (entry.outcome?.status === "ok") return;
		completeSubagentRun({
			runId: params.runId,
			endedAt: pending.endedAt,
			outcome: { status: "timeout" },
			reason: SUBAGENT_ENDED_REASON_COMPLETE,
			sendFarewell: true,
			accountId: entry.requesterOrigin?.accountId,
			triggerCleanup: true
		});
	}, LIFECYCLE_TIMEOUT_RETRY_GRACE_MS);
	timer.unref?.();
	pendingLifecycleTimeoutByRunId.set(params.runId, {
		timer,
		endedAt: params.endedAt
	});
}
async function notifyContextEngineSubagentEnded(params) {
	try {
		const cfg = subagentRegistryDeps.getRuntimeConfig();
		await ensureSubagentRegistryPluginRuntimeLoaded({
			config: cfg,
			workspaceDir: params.workspaceDir,
			allowGatewaySubagentBinding: true
		});
		const engine = await resolveSubagentRegistryContextEngine(cfg, {
			agentDir: params.agentDir,
			workspaceDir: params.workspaceDir
		});
		if (!engine.onSubagentEnded) return;
		await engine.onSubagentEnded(params);
	} catch (err) {
		log.warn("context-engine onSubagentEnded failed (best-effort)", { err });
	}
}
function suppressAnnounceForSteerRestart(entry) {
	return entry?.suppressAnnounceReason === "steer-restart";
}
function shouldKeepThreadBindingAfterRun(params) {
	if (params.reason === "subagent-killed") return false;
	return params.entry.spawnMode === "session";
}
function shouldEmitEndedHookForRun(params) {
	return !shouldKeepThreadBindingAfterRun(params);
}
async function emitSubagentEndedHookForRun(params) {
	if (params.entry.endedHookEmittedAt) return;
	await ensureSubagentRegistryPluginRuntimeLoaded({
		config: subagentRegistryDeps.getRuntimeConfig(),
		workspaceDir: params.entry.workspaceDir,
		allowGatewaySubagentBinding: true
	});
	const reason = params.reason ?? params.entry.endedReason ?? "subagent-complete";
	const outcome = resolveLifecycleOutcomeFromRunOutcome(params.entry.outcome);
	const error = params.entry.outcome?.status === "error" ? params.entry.outcome.error : void 0;
	await emitSubagentEndedHookOnce({
		entry: params.entry,
		reason,
		sendFarewell: params.sendFarewell,
		accountId: params.accountId ?? params.entry.requesterOrigin?.accountId,
		outcome,
		error,
		inFlightRunIds: endedHookInFlightRunIds,
		persist: persistSubagentRuns
	});
}
const { clearScheduledResumeTimers, completeCleanupBookkeeping, completeSubagentRun, finalizeResumedAnnounceGiveUp, refreshFrozenResultFromSession, startSubagentAnnounceCleanupFlow } = createSubagentRegistryLifecycleController({
	runs: subagentRuns,
	resumedRuns,
	subagentAnnounceTimeoutMs: SUBAGENT_ANNOUNCE_TIMEOUT_MS,
	persist: persistSubagentRuns,
	clearPendingLifecycleError,
	countPendingDescendantRuns,
	suppressAnnounceForSteerRestart,
	shouldEmitEndedHookForRun,
	emitSubagentEndedHookForRun,
	notifyContextEngineSubagentEnded,
	resumeSubagentRun,
	callGateway: (request) => subagentRegistryDeps.callGateway(request),
	captureSubagentCompletionReply: (sessionKey, options) => subagentRegistryDeps.captureSubagentCompletionReply(sessionKey, options),
	cleanupBrowserSessionsForLifecycleEnd: (args) => subagentRegistryDeps.cleanupBrowserSessionsForLifecycleEnd(args),
	runSubagentAnnounceFlow: (params) => subagentRegistryDeps.runSubagentAnnounceFlow(params),
	warn: (message, meta) => log.warn(message, meta)
});
function resumeSubagentRun(runId) {
	if (!runId || resumedRuns.has(runId)) return;
	const entry = subagentRuns.get(runId);
	if (!entry) return;
	if (entry.cleanupCompletedAt) return;
	if (typeof entry.endedAt === "number" && entry.pendingFinalDelivery === true && typeof entry.deliverySuspendedAt === "number") return;
	if (entry.pauseReason === "sessions_yield") return;
	if ((entry.announceRetryCount ?? 0) >= 3) {
		finalizeResumedAnnounceGiveUp({
			runId,
			entry,
			reason: "retry-limit"
		});
		return;
	}
	if (entry.expectsCompletionMessage !== true && typeof entry.endedAt === "number" && Date.now() - entry.endedAt > 3e5) {
		finalizeResumedAnnounceGiveUp({
			runId,
			entry,
			reason: "expiry"
		});
		return;
	}
	const now = Date.now();
	const delayMs = resolveAnnounceRetryDelayMs(entry.announceRetryCount ?? 0);
	const earliestRetryAt = (entry.lastAnnounceRetryAt ?? 0) + delayMs;
	if (entry.expectsCompletionMessage === true && entry.lastAnnounceRetryAt && now < earliestRetryAt) {
		const waitMs = Math.max(1, earliestRetryAt - now);
		const scheduledEntry = entry;
		const timer = setTimeout(() => {
			resumeRetryTimers.delete(timer);
			if (subagentRuns.get(runId) !== scheduledEntry) return;
			resumedRuns.delete(runId);
			resumeSubagentRun(runId);
		}, waitMs);
		timer.unref?.();
		resumeRetryTimers.add(timer);
		resumedRuns.add(runId);
		return;
	}
	if (typeof entry.endedAt === "number" && entry.endedAt > 0) {
		const orphanReason = resolveSubagentRunOrphanReason({ entry });
		if (orphanReason) {
			if (reconcileOrphanedRun({
				runId,
				entry,
				reason: orphanReason,
				source: "resume",
				runs: subagentRuns,
				resumedRuns
			})) persistSubagentRuns();
			return;
		}
		if (suppressAnnounceForSteerRestart(entry)) {
			resumedRuns.add(runId);
			return;
		}
		if (!startSubagentAnnounceCleanupFlow(runId, entry)) return;
		resumedRuns.add(runId);
		return;
	}
	const waitTimeoutMs = resolveSubagentWaitTimeoutMs(subagentRegistryDeps.getRuntimeConfig(), entry.runTimeoutSeconds);
	subagentRunManager.waitForSubagentCompletion(runId, waitTimeoutMs, entry);
	resumedRuns.add(runId);
}
function restoreSubagentRunsOnce() {
	if (restoreAttempted) return;
	restoreAttempted = true;
	try {
		if (subagentRegistryDeps.restoreSubagentRunsFromDisk({
			runs: subagentRuns,
			mergeOnly: true
		}) === 0) return;
		if (reconcileOrphanedRestoredRuns({
			runs: subagentRuns,
			resumedRuns
		})) persistSubagentRuns();
		if (subagentRuns.size === 0) return;
		ensureListener();
		startSweeper();
		for (const runId of subagentRuns.keys()) resumeSubagentRun(runId);
		scheduleSubagentOrphanRecovery();
	} catch {}
}
function resolveSubagentWaitTimeoutMs(cfg, runTimeoutSeconds) {
	return subagentRegistryDeps.resolveAgentTimeoutMs({
		cfg,
		overrideSeconds: runTimeoutSeconds ?? 0
	});
}
function startSweeper() {
	if (sweeper) return;
	sweeper = setInterval(() => {
		if (sweepInProgress) return;
		sweepSubagentRuns();
	}, 6e4);
	sweeper.unref?.();
}
function stopSweeper() {
	if (!sweeper) return;
	clearInterval(sweeper);
	sweeper = null;
}
function isSuspendedPendingFinalDelivery(entry) {
	return typeof entry.endedAt === "number" && entry.pendingFinalDelivery === true && typeof entry.deliverySuspendedAt === "number";
}
function resolveSuspendedDeliveryExpiryMs(entry) {
	const requester = entry.requesterSessionKey;
	if (requester.includes(":cron:")) return SUSPENDED_DELIVERY_CRON_EXPIRY_MS;
	if (requester.includes(":subagent:")) return SUSPENDED_DELIVERY_SUBAGENT_EXPIRY_MS;
	return SUSPENDED_DELIVERY_INTERACTIVE_EXPIRY_MS;
}
async function discardSuspendedPendingFinalDelivery(runId, entry, now, reason) {
	const payload = entry.pendingFinalDeliveryPayload;
	entry.deliveryDiscardedAt = now;
	entry.deliveryDiscardReason = reason;
	entry.deliveryDiscardedPayloadSummary = {
		requesterSessionKey: payload?.requesterSessionKey ?? entry.requesterSessionKey,
		childSessionKey: payload?.childSessionKey ?? entry.childSessionKey,
		childRunId: payload?.childRunId ?? entry.runId,
		endedAt: payload?.endedAt ?? entry.endedAt,
		status: payload?.outcome?.status ?? entry.outcome?.status,
		lastError: entry.lastAnnounceDeliveryError ?? entry.pendingFinalDeliveryLastError ?? null
	};
	entry.pendingFinalDelivery = void 0;
	entry.pendingFinalDeliveryCreatedAt = void 0;
	entry.pendingFinalDeliveryLastAttemptAt = void 0;
	entry.pendingFinalDeliveryAttemptCount = void 0;
	entry.pendingFinalDeliveryLastError = void 0;
	entry.pendingFinalDeliveryPayload = void 0;
	entry.deliverySuspendedAt = void 0;
	entry.deliverySuspendedReason = void 0;
	entry.wakeOnDescendantSettle = void 0;
	entry.fallbackFrozenResultText = void 0;
	entry.fallbackFrozenResultCapturedAt = void 0;
	entry.cleanupHandled = true;
	entry.completionAnnouncedAt = void 0;
	resumedRuns.delete(runId);
	clearPendingLifecycleError(runId);
	clearPendingLifecycleTimeout(runId);
	log.warn("subagent suspended delivery discarded", {
		reason,
		runId: entry.runId,
		childSessionKey: entry.childSessionKey,
		requesterSessionKey: entry.requesterSessionKey
	});
	if (entry.cleanup === "delete" || !entry.retainAttachmentsOnKeep) await safeRemoveAttachmentsDir(entry);
	const completionReason = entry.endedReason ?? "subagent-complete";
	completeCleanupBookkeeping({
		runId,
		entry,
		cleanup: entry.cleanup,
		completedAt: now
	});
	if (entry.expectsCompletionMessage === true && shouldEmitEndedHookForRun({
		entry,
		reason: completionReason
	})) await emitSubagentEndedHookForRun({
		entry,
		reason: completionReason,
		sendFarewell: true
	});
}
async function sweepSubagentRuns() {
	if (sweepInProgress) return;
	sweepInProgress = true;
	try {
		const now = Date.now();
		const storeCache = /* @__PURE__ */ new Map();
		let mutated = false;
		const suspendedEntries = [...subagentRuns.entries()].filter(([, entry]) => isSuspendedPendingFinalDelivery(entry));
		const pressureDiscardRunIds = /* @__PURE__ */ new Set();
		if (suspendedEntries.length > SUSPENDED_DELIVERY_HARD_CAP) {
			const pressureCount = Math.max(0, suspendedEntries.length - SUSPENDED_DELIVERY_PRESSURE_TARGET);
			for (const [runId] of suspendedEntries.toSorted((a, b) => (a[1].deliverySuspendedAt ?? 0) - (b[1].deliverySuspendedAt ?? 0)).slice(0, pressureCount)) pressureDiscardRunIds.add(runId);
			log.warn("subagent suspended delivery backlog exceeded pressure cap", {
				suspendedCount: suspendedEntries.length,
				softCap: SUSPENDED_DELIVERY_SOFT_CAP,
				hardCap: SUSPENDED_DELIVERY_HARD_CAP,
				pressureTarget: SUSPENDED_DELIVERY_PRESSURE_TARGET,
				pressureDiscardCount: pressureDiscardRunIds.size
			});
		}
		for (const [runId, entry] of subagentRuns.entries()) {
			if (isSuspendedPendingFinalDelivery(entry)) {
				const expired = now - (entry.deliverySuspendedAt ?? now) >= resolveSuspendedDeliveryExpiryMs(entry);
				if (expired || pressureDiscardRunIds.has(runId)) {
					await discardSuspendedPendingFinalDelivery(runId, entry, now, expired ? "expired" : "pressure-pruned");
					mutated = true;
				}
				continue;
			}
			if (typeof entry.endedAt !== "number") {
				const hasLiveRunContext = Boolean(getAgentRunContext(runId));
				const activeAgeMs = now - (entry.startedAt ?? entry.createdAt);
				if (!hasLiveRunContext && activeAgeMs >= STALE_ACTIVE_SUBAGENT_GRACE_MS) {
					const orphanReason = resolveSubagentRunOrphanReason({
						entry,
						storeCache
					});
					if (orphanReason) {
						if (reconcileOrphanedRun({
							runId,
							entry,
							reason: orphanReason,
							source: "resume",
							runs: subagentRuns,
							resumedRuns
						})) mutated = true;
						continue;
					}
					const sessionEntry = loadSubagentSessionEntry({
						childSessionKey: entry.childSessionKey,
						storeCache
					});
					const completion = resolveCompletionFromSessionEntry(sessionEntry, now, { notBeforeMs: entry.startedAt ?? entry.createdAt });
					if (completion) {
						await completeSubagentRun({
							runId,
							endedAt: completion.endedAt,
							outcome: completion.outcome,
							reason: completion.reason,
							sendFarewell: true,
							accountId: entry.requesterOrigin?.accountId,
							triggerCleanup: true
						});
						continue;
					}
					if (sessionEntry?.abortedLastRun === true) {
						scheduleSubagentOrphanRecovery({ delayMs: 1e3 });
						continue;
					}
					await completeSubagentRun({
						runId,
						endedAt: now,
						outcome: {
							status: "error",
							error: "subagent run lost active execution context"
						},
						reason: SUBAGENT_ENDED_REASON_ERROR,
						sendFarewell: true,
						accountId: entry.requesterOrigin?.accountId,
						triggerCleanup: true
					});
					continue;
				}
			}
			if (!entry.archiveAtMs && entry.cleanup === "keep" && entry.spawnMode !== "session") continue;
			if (!entry.archiveAtMs) {
				if (typeof entry.cleanupCompletedAt === "number" && now - entry.cleanupCompletedAt > SESSION_RUN_TTL_MS) {
					clearPendingLifecycleError(runId);
					notifyContextEngineSubagentEnded({
						childSessionKey: entry.childSessionKey,
						reason: "swept",
						agentDir: entry.agentDir,
						workspaceDir: entry.workspaceDir
					});
					subagentRuns.delete(runId);
					mutated = true;
					if (!entry.retainAttachmentsOnKeep) await safeRemoveAttachmentsDir(entry);
				}
				continue;
			}
			if (entry.archiveAtMs > now) continue;
			clearPendingLifecycleError(runId);
			try {
				await subagentRegistryDeps.callGateway({
					method: "sessions.delete",
					params: {
						key: entry.childSessionKey,
						deleteTranscript: true,
						emitLifecycleHooks: false
					},
					timeoutMs: 1e4
				});
			} catch (err) {
				log.warn("sessions.delete failed during subagent sweep; keeping run for retry", {
					runId,
					childSessionKey: entry.childSessionKey,
					err
				});
				continue;
			}
			subagentRuns.delete(runId);
			mutated = true;
			await safeRemoveAttachmentsDir(entry);
			notifyContextEngineSubagentEnded({
				childSessionKey: entry.childSessionKey,
				reason: "swept",
				agentDir: entry.agentDir,
				workspaceDir: entry.workspaceDir
			});
		}
		for (const [runId, pending] of pendingLifecycleErrorByRunId.entries()) if (now - pending.endedAt > PENDING_LIFECYCLE_TERMINAL_TTL_MS) clearPendingLifecycleError(runId);
		for (const [runId, pending] of pendingLifecycleTimeoutByRunId.entries()) if (now - pending.endedAt > PENDING_LIFECYCLE_TERMINAL_TTL_MS) clearPendingLifecycleTimeout(runId);
		if (mutated) persistSubagentRuns();
		if (subagentRuns.size === 0) stopSweeper();
	} finally {
		sweepInProgress = false;
	}
}
function ensureListener() {
	if (listenerStarted) return;
	listenerStarted = true;
	subagentRegistryDeps.onAgentEvent((evt) => {
		(async () => {
			if (!evt || evt.stream !== "lifecycle") return;
			const phase = evt.data?.phase;
			const entry = subagentRuns.get(evt.runId);
			if (!entry) {
				if (phase === "end" && typeof evt.sessionKey === "string") await refreshFrozenResultFromSession(evt.sessionKey);
				return;
			}
			if (phase === "start") {
				clearPendingLifecycleError(evt.runId);
				clearPendingLifecycleTimeout(evt.runId);
				const startedAt = typeof evt.data?.startedAt === "number" ? evt.data.startedAt : void 0;
				if (startedAt) {
					entry.startedAt = startedAt;
					if (typeof entry.sessionStartedAt !== "number") entry.sessionStartedAt = startedAt;
					persistSubagentRuns();
				}
				return;
			}
			if (phase !== "end" && phase !== "error") return;
			const endedAt = typeof evt.data?.endedAt === "number" ? evt.data.endedAt : Date.now();
			const error = typeof evt.data?.error === "string" ? evt.data.error : void 0;
			const livenessState = typeof evt.data?.livenessState === "string" ? evt.data.livenessState : void 0;
			if (phase === "error") {
				schedulePendingLifecycleError({
					runId: evt.runId,
					endedAt,
					error
				});
				return;
			}
			if (isBlockedLivenessState(livenessState)) {
				clearPendingLifecycleError(evt.runId);
				clearPendingLifecycleTimeout(evt.runId);
				await completeSubagentRun({
					runId: evt.runId,
					endedAt,
					outcome: {
						status: "error",
						error: formatBlockedLivenessError(error)
					},
					reason: SUBAGENT_ENDED_REASON_ERROR,
					sendFarewell: true,
					accountId: entry.requesterOrigin?.accountId,
					triggerCleanup: true
				});
				return;
			}
			if (evt.data?.aborted) {
				schedulePendingLifecycleTimeout({
					runId: evt.runId,
					endedAt
				});
				return;
			}
			if (evt.data?.yielded === true) {
				if (markSubagentRunPausedAfterYield({
					entry,
					endedAt,
					startedAt: typeof evt.data?.startedAt === "number" ? evt.data.startedAt : entry.startedAt
				})) persistSubagentRuns();
				return;
			}
			clearPendingLifecycleError(evt.runId);
			clearPendingLifecycleTimeout(evt.runId);
			await completeSubagentRun({
				runId: evt.runId,
				endedAt,
				outcome: { status: "ok" },
				reason: SUBAGENT_ENDED_REASON_COMPLETE,
				sendFarewell: true,
				accountId: entry.requesterOrigin?.accountId,
				triggerCleanup: true
			});
		})();
	});
}
const subagentRunManager = createSubagentRunManager({
	runs: subagentRuns,
	resumedRuns,
	endedHookInFlightRunIds,
	persist: persistSubagentRuns,
	persistOrThrow: persistSubagentRunsOrThrow,
	callGateway: (request) => subagentRegistryDeps.callGateway(request),
	getRuntimeConfig: () => subagentRegistryDeps.getRuntimeConfig(),
	ensureRuntimePluginsLoaded: (args) => ensureSubagentRegistryPluginRuntimeLoaded(args),
	ensureListener,
	startSweeper,
	stopSweeper,
	resumeSubagentRun,
	clearPendingLifecycleError,
	resolveSubagentWaitTimeoutMs,
	scheduleOrphanRecovery: (args) => scheduleSubagentOrphanRecovery(args),
	resolveSubagentSessionCompletion,
	notifyContextEngineSubagentEnded,
	completeCleanupBookkeeping,
	completeSubagentRun
});
configureSubagentRegistrySteerRuntime({
	replaceSubagentRunAfterSteer: (params) => subagentRunManager.replaceSubagentRunAfterSteer(params),
	finalizeInterruptedSubagentRun: async (params) => await finalizeInterruptedSubagentRun(params)
});
function markSubagentRunForSteerRestart(runId) {
	return subagentRunManager.markSubagentRunForSteerRestart(runId);
}
function clearSubagentRunSteerRestart(runId) {
	return subagentRunManager.clearSubagentRunSteerRestart(runId);
}
function replaceSubagentRunAfterSteer(params) {
	return subagentRunManager.replaceSubagentRunAfterSteer(params);
}
function registerSubagentRun(params) {
	subagentRunManager.registerSubagentRun(params);
}
async function finalizeInterruptedSubagentRun(params) {
	const runIds = /* @__PURE__ */ new Set();
	if (typeof params.runId === "string" && params.runId.trim()) runIds.add(params.runId.trim());
	if (typeof params.childSessionKey === "string" && params.childSessionKey.trim()) {
		const childSessionKey = params.childSessionKey.trim();
		for (const [runId, entry] of subagentRuns.entries()) if (entry.childSessionKey === childSessionKey) runIds.add(runId);
	}
	if (runIds.size === 0) return 0;
	const endedAt = typeof params.endedAt === "number" && Number.isFinite(params.endedAt) ? params.endedAt : Date.now();
	let updated = 0;
	for (const runId of runIds) {
		clearPendingLifecycleError(runId);
		clearPendingLifecycleTimeout(runId);
		const entry = subagentRuns.get(runId);
		if (!entry || typeof entry.cleanupCompletedAt === "number") continue;
		await completeSubagentRun({
			runId,
			endedAt,
			outcome: {
				status: "error",
				error: params.error
			},
			reason: SUBAGENT_ENDED_REASON_ERROR,
			sendFarewell: true,
			accountId: entry.requesterOrigin?.accountId,
			triggerCleanup: true
		});
		updated += 1;
	}
	return updated;
}
function markSubagentRunTerminated(params) {
	return subagentRunManager.markSubagentRunTerminated(params);
}
function listSubagentRunsForController(controllerSessionKey) {
	return listRunsForControllerFromRuns(subagentRegistryDeps.getSubagentRunsSnapshotForRead(subagentRuns), controllerSessionKey);
}
function countActiveRunsForSession(requesterSessionKey) {
	return countActiveRunsForSessionFromRuns(subagentRegistryDeps.getSubagentRunsSnapshotForRead(subagentRuns), requesterSessionKey);
}
function countActiveDescendantRuns(rootSessionKey) {
	return countActiveDescendantRunsFromRuns(subagentRegistryDeps.getSubagentRunsSnapshotForRead(subagentRuns), rootSessionKey);
}
function countPendingDescendantRuns(rootSessionKey) {
	return countPendingDescendantRunsFromRuns(subagentRegistryDeps.getSubagentRunsSnapshotForRead(subagentRuns), rootSessionKey);
}
function listDescendantRunsForRequester(rootSessionKey) {
	return listDescendantRunsForRequesterFromRuns(subagentRegistryDeps.getSubagentRunsSnapshotForRead(subagentRuns), rootSessionKey);
}
function getSubagentRunByChildSessionKey(childSessionKey) {
	return getSubagentRunByChildSessionKeyFromRuns(subagentRegistryDeps.getSubagentRunsSnapshotForRead(subagentRuns), childSessionKey);
}
function getLatestSubagentRunByChildSessionKey(childSessionKey) {
	const key = childSessionKey.trim();
	if (!key) return null;
	let latest = null;
	for (const entry of subagentRegistryDeps.getSubagentRunsSnapshotForRead(subagentRuns).values()) {
		if (entry.childSessionKey !== key) continue;
		if (!latest || entry.createdAt > latest.createdAt) latest = entry;
	}
	return latest;
}
function initSubagentRegistry() {
	restoreSubagentRunsOnce();
}
//#endregion
export { finalizeInterruptedSubagentRun as a, initSubagentRegistry as c, markSubagentRunForSteerRestart as d, markSubagentRunTerminated as f, listSessionMaintenanceProtectedSubagentSessionKeys as g, scheduleSubagentOrphanRecovery as h, countPendingDescendantRuns as i, listDescendantRunsForRequester as l, replaceSubagentRunAfterSteer as m, countActiveDescendantRuns as n, getLatestSubagentRunByChildSessionKey as o, registerSubagentRun as p, countActiveRunsForSession as r, getSubagentRunByChildSessionKey as s, clearSubagentRunSteerRestart as t, listSubagentRunsForController as u };
