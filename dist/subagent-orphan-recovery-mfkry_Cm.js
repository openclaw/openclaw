import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { d as resolveAgentIdFromSessionKey } from "./session-key-Bte0mmcq.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { i as getRuntimeConfig } from "./io-DoswVvYe.js";
import "./config-B6Oplu5W.js";
import { r as callGateway } from "./call-t1U2G3yY.js";
import { u as resolveStorePath } from "./paths-Bg3PO6Gj.js";
import { t as loadSessionStore } from "./store-load-z4thf6ld.js";
import { u as updateSessionStore } from "./store-BmtchQvp.js";
import "./sessions-CQHHcgC_.js";
import { l as readSessionMessagesAsync } from "./session-utils.fs-CsnHXIqH.js";
import { a as markSubagentRecoveryAttempt, n as evaluateSubagentRecoveryGate, o as markSubagentRecoveryWedged } from "./subagent-recovery-state-Chw_zLIZ.js";
import { n as isInternalAnnounceRequesterSession, r as loadRequesterSessionEntry, t as deliverSubagentAnnouncement } from "./subagent-announce-delivery-p160OmJs.js";
import { n as buildAnnounceIdempotencyKey } from "./announce-idempotency-DV6_8Blm.js";
import { n as finalizeInterruptedSubagentRun, r as replaceSubagentRunAfterSteer } from "./subagent-registry-steer-runtime-9Vso0zzU.js";
import { t as resolveAnnounceOrigin } from "./subagent-announce-origin-boXMvsL2.js";
import crypto from "node:crypto";
//#region src/agents/subagent-orphan-recovery.ts
/**
* Post-restart orphan recovery for subagent sessions.
*
* After a SIGUSR1 gateway reload aborts in-flight subagent LLM calls,
* this module scans for orphaned sessions (those with `abortedLastRun: true`
* that are still tracked as active in the subagent registry) and sends a
* synthetic resume message to restart their work.
*
* @see https://github.com/openclaw/openclaw/issues/47711
*/
const log = createSubsystemLogger("subagent-orphan-recovery");
/** Delay before attempting recovery to let the gateway finish bootstrapping. */
const DEFAULT_RECOVERY_DELAY_MS = 5e3;
function isRestartAbortedTimeoutRun(runRecord, entry) {
	return entry?.abortedLastRun === true && runRecord.outcome?.status === "timeout" && typeof runRecord.endedAt === "number" && runRecord.endedAt > 0;
}
/**
* Build the resume message for an orphaned subagent.
*/
function buildResumeMessage(task, lastHumanMessage) {
	const maxTaskLen = 2e3;
	let message = `[System] Your previous turn was interrupted by a gateway reload. Your original task was:\n\n${task.length > maxTaskLen ? `${task.slice(0, maxTaskLen)}...` : task}\n\n`;
	if (lastHumanMessage) message += `The last message from the user before the interruption was:\n\n${lastHumanMessage}\n\n`;
	message += `Please continue where you left off.`;
	return message;
}
function buildRecoveryProgressPrompt(params) {
	const maxTaskLen = 160;
	return `A spawned subagent task was interrupted by a gateway restart or connection loss. Automatic recovery is already in progress for "${params.task.length > maxTaskLen ? `${params.task.slice(0, maxTaskLen)}...` : params.task}" (retry ${params.attemptNumber}/${params.maxAttempts}). Send one brief update now in your normal voice: say the task was interrupted, you are automatically resuming/retrying it, and you will report back when it either continues or truly fails. Do not say the task has failed.`;
}
async function announceRecoveryInProgress(params) {
	const requesterSessionKey = params.runRecord.requesterSessionKey?.trim();
	if (!requesterSessionKey) return false;
	const requesterOrigin = params.runRecord.requesterOrigin;
	const requesterIsSubagent = isInternalAnnounceRequesterSession(requesterSessionKey);
	let directOrigin = requesterOrigin;
	if (!requesterIsSubagent) {
		const { entry } = loadRequesterSessionEntry(requesterSessionKey);
		directOrigin = resolveAnnounceOrigin(entry, requesterOrigin);
	}
	const prompt = buildRecoveryProgressPrompt({
		task: params.runRecord.label || params.runRecord.task,
		attemptNumber: params.attemptNumber,
		maxAttempts: params.maxAttempts
	});
	try {
		return (await deliverSubagentAnnouncement({
			requesterSessionKey,
			announceId: `${params.runRecord.runId}:recovery-progress`,
			triggerMessage: prompt,
			steerMessage: prompt,
			summaryLine: params.runRecord.label || params.runRecord.task,
			requesterSessionOrigin: requesterOrigin,
			requesterOrigin,
			completionDirectOrigin: requesterOrigin,
			directOrigin,
			sourceSessionKey: params.runRecord.childSessionKey,
			sourceTool: "subagent_orphan_recovery",
			targetRequesterSessionKey: requesterSessionKey,
			requesterIsSubagent,
			expectsCompletionMessage: false,
			bestEffortDeliver: true,
			directIdempotencyKey: buildAnnounceIdempotencyKey(`${params.runRecord.runId}:recovery-progress`)
		})).delivered;
	} catch {
		return false;
	}
}
function extractMessageText(msg) {
	if (!msg || typeof msg !== "object") return;
	const m = msg;
	if (typeof m.content === "string") return m.content;
	if (Array.isArray(m.content)) return m.content.filter((c) => typeof c === "object" && c !== null && c.type === "text" && typeof c.text === "string").map((c) => c.text).filter(Boolean).join("\n") || void 0;
}
/**
* Send a resume message to an orphaned subagent session via the gateway agent method.
*/
async function resumeOrphanedSession(params) {
	let resumeMessage = buildResumeMessage(params.task, params.lastHumanMessage);
	if (params.configChangeHint) resumeMessage += params.configChangeHint;
	try {
		const result = await callGateway({
			method: "agent",
			params: {
				message: resumeMessage,
				sessionKey: params.sessionKey,
				idempotencyKey: crypto.randomUUID(),
				deliver: false,
				lane: "subagent"
			},
			timeoutMs: 1e4
		});
		if (!replaceSubagentRunAfterSteer({
			previousRunId: params.originalRunId,
			nextRunId: result.runId,
			fallback: params.originalRun
		})) {
			log.warn(`resumed orphaned session ${params.sessionKey} but remap failed (old run already removed); treating resume as accepted to avoid duplicate restarts`);
			return { resumed: true };
		}
		log.info(`resumed orphaned session: ${params.sessionKey}`);
		return { resumed: true };
	} catch (err) {
		const error = formatErrorMessage(err);
		log.warn(`failed to resume orphaned session ${params.sessionKey}: ${error}`);
		return {
			resumed: false,
			error
		};
	}
}
/**
* Scan for and resume orphaned subagent sessions after a gateway restart.
*
* An orphaned session is one where:
* 1. It has an active (not ended) entry in the subagent run registry
* 2. Its session store entry has `abortedLastRun: true`
*
* For each orphaned session found, we:
* 1. Clear the `abortedLastRun` flag
* 2. Send a synthetic resume message to trigger a new LLM turn
*/
async function recoverOrphanedSubagentSessions(params) {
	const result = {
		recovered: 0,
		failed: 0,
		skipped: 0,
		failedRuns: []
	};
	const resumedSessionKeys = params.resumedSessionKeys ?? /* @__PURE__ */ new Set();
	const attemptNumber = Math.max(1, params.attemptNumber ?? 1);
	const maxAttempts = Math.max(attemptNumber, params.maxAttempts ?? attemptNumber);
	const notifiedRecoverySessionKeys = params.notifiedRecoverySessionKeys ?? /* @__PURE__ */ new Set();
	const configChangePattern = /openclaw\.json|openclaw gateway restart|config\.patch/i;
	try {
		const activeRuns = params.getActiveRuns();
		if (activeRuns.size === 0) return result;
		const cfg = getRuntimeConfig();
		const storeCache = /* @__PURE__ */ new Map();
		for (const [runId, runRecord] of activeRuns.entries()) {
			const childSessionKey = runRecord.childSessionKey?.trim();
			if (!childSessionKey) continue;
			const now = Date.now();
			if (resumedSessionKeys.has(childSessionKey)) {
				result.skipped++;
				continue;
			}
			try {
				const agentId = resolveAgentIdFromSessionKey(childSessionKey);
				const storePath = resolveStorePath(cfg.session?.store, { agentId });
				let store = storeCache.get(storePath);
				if (!store) {
					store = loadSessionStore(storePath);
					storeCache.set(storePath, store);
				}
				const entry = store[childSessionKey];
				if (!entry) {
					result.skipped++;
					continue;
				}
				if (typeof runRecord.endedAt === "number" && runRecord.endedAt > 0 && !isRestartAbortedTimeoutRun(runRecord, entry)) {
					result.skipped++;
					continue;
				}
				if (!entry.abortedLastRun) {
					result.skipped++;
					continue;
				}
				const recoveryGate = evaluateSubagentRecoveryGate(entry, now);
				if (!recoveryGate.allowed) {
					if (recoveryGate.shouldMarkWedged) try {
						await updateSessionStore(storePath, (currentStore) => {
							const current = currentStore[childSessionKey];
							if (current) {
								markSubagentRecoveryWedged({
									entry: current,
									now,
									runId,
									reason: recoveryGate.reason
								});
								currentStore[childSessionKey] = current;
							}
						});
						markSubagentRecoveryWedged({
							entry,
							now,
							runId,
							reason: recoveryGate.reason
						});
					} catch (err) {
						log.warn(`failed to persist wedged subagent recovery marker for ${childSessionKey}: ${String(err)}`);
					}
					log.warn(`skipping orphan recovery for ${childSessionKey}: ${recoveryGate.reason}`);
					result.skipped++;
					result.failedRuns.push({
						runId,
						childSessionKey,
						error: recoveryGate.reason
					});
					continue;
				}
				log.info(`found orphaned subagent session: ${childSessionKey} (run=${runId})`);
				const messages = await readSessionMessagesAsync(entry.sessionId, storePath, entry.sessionFile, {
					mode: "recent",
					maxMessages: 200,
					maxBytes: 1024 * 1024
				});
				const lastHumanMessage = [...messages].toReversed().find((msg) => msg?.role === "user");
				const configChangeDetected = messages.some((msg) => {
					if (msg?.role !== "assistant") return false;
					const text = extractMessageText(msg);
					return typeof text === "string" && configChangePattern.test(text);
				});
				if (attemptNumber > 1 && !notifiedRecoverySessionKeys.has(childSessionKey)) {
					if (await announceRecoveryInProgress({
						runRecord,
						attemptNumber,
						maxAttempts
					})) notifiedRecoverySessionKeys.add(childSessionKey);
				}
				const resumeResult = await resumeOrphanedSession({
					sessionKey: childSessionKey,
					task: runRecord.task,
					lastHumanMessage: extractMessageText(lastHumanMessage),
					configChangeHint: configChangeDetected ? "\n\n[config changes from your previous run were already applied — do not re-modify openclaw.json or restart the gateway]" : void 0,
					originalRunId: runId,
					originalRun: runRecord
				});
				if (resumeResult.resumed) {
					resumedSessionKeys.add(childSessionKey);
					try {
						await updateSessionStore(storePath, (currentStore) => {
							const current = currentStore[childSessionKey];
							if (current) {
								current.abortedLastRun = false;
								markSubagentRecoveryAttempt({
									entry: current,
									now: Date.now(),
									runId,
									attempt: recoveryGate.nextAttempt
								});
								current.updatedAt = Date.now();
								currentStore[childSessionKey] = current;
							}
						});
					} catch (err) {
						log.warn(`resume succeeded but failed to update session store for ${childSessionKey}: ${String(err)}`);
					}
					result.recovered++;
				} else {
					log.warn(`resume failed for ${childSessionKey}; abortedLastRun flag preserved for retry on next restart`);
					result.failed++;
					result.failedRuns.push({
						runId,
						childSessionKey,
						error: resumeResult.error
					});
				}
			} catch (err) {
				const error = formatErrorMessage(err);
				log.warn(`error processing orphaned session ${childSessionKey}: ${error}`);
				result.failed++;
				result.failedRuns.push({
					runId,
					childSessionKey,
					error
				});
			}
		}
	} catch (err) {
		log.warn(`orphan recovery scan failed: ${String(err)}`);
		if (result.failed === 0) result.failed = 1;
	}
	if (result.recovered > 0 || result.failed > 0) log.info(`orphan recovery complete: recovered=${result.recovered} failed=${result.failed} skipped=${result.skipped}`);
	return result;
}
/** Maximum number of retry attempts for orphan recovery. */
const MAX_RECOVERY_RETRIES = 3;
/** Backoff multiplier between retries (exponential). */
const RETRY_BACKOFF_MULTIPLIER = 2;
function buildRecoveryFailureMessage(params) {
	const base = `Subagent run was interrupted by a gateway restart or connection loss. Automatic recovery failed after ${params.attempts} attempt${params.attempts === 1 ? "" : "s"}. Please retry.`;
	const detail = params.error?.trim();
	if (!detail) return base;
	return `${base} (${detail})`;
}
/**
* Schedule orphan recovery after a delay, with retry logic.
* The delay gives the gateway time to fully bootstrap after restart.
* If recovery fails (e.g. gateway not yet ready), retries with exponential backoff.
*/
function scheduleOrphanRecovery(params) {
	const initialDelay = params.delayMs ?? DEFAULT_RECOVERY_DELAY_MS;
	const maxRetries = params.maxRetries ?? MAX_RECOVERY_RETRIES;
	const resumedSessionKeys = /* @__PURE__ */ new Set();
	const notifiedRecoverySessionKeys = /* @__PURE__ */ new Set();
	const attemptRecovery = (attempt, delay) => {
		setTimeout(() => {
			recoverOrphanedSubagentSessions({
				...params,
				resumedSessionKeys,
				attemptNumber: attempt + 1,
				maxAttempts: maxRetries + 1,
				notifiedRecoverySessionKeys
			}).then((result) => {
				if (result.failed > 0 && attempt < maxRetries) {
					const nextDelay = delay * RETRY_BACKOFF_MULTIPLIER;
					log.info(`orphan recovery had ${result.failed} failure(s); retrying in ${nextDelay}ms (attempt ${attempt + 1}/${maxRetries})`);
					attemptRecovery(attempt + 1, nextDelay);
					return;
				}
				if (result.failedRuns.length === 0) return;
				const attempts = attempt + 1;
				Promise.allSettled(result.failedRuns.map((run) => finalizeInterruptedSubagentRun({
					runId: run.runId,
					childSessionKey: run.childSessionKey,
					error: buildRecoveryFailureMessage({
						attempts,
						error: run.error
					})
				})));
			}).catch((err) => {
				if (attempt < maxRetries) {
					const nextDelay = delay * RETRY_BACKOFF_MULTIPLIER;
					log.warn(`scheduled orphan recovery failed: ${String(err)}; retrying in ${nextDelay}ms (attempt ${attempt + 1}/${maxRetries})`);
					attemptRecovery(attempt + 1, nextDelay);
				} else log.warn(`scheduled orphan recovery failed after ${maxRetries} retries: ${String(err)}`);
			});
		}, delay).unref?.();
	};
	attemptRecovery(0, initialDelay);
}
//#endregion
export { scheduleOrphanRecovery };
