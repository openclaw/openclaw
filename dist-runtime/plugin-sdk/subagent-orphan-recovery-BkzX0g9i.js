import { d as resolveAgentIdFromSessionKey } from "./session-key-BwICpQs5.js";
import "./runtime-CDMAx_h4.js";
import { Bs as readSessionMessages, Is as updateSessionStore, Vn as replaceSubagentRunAfterSteer, js as loadSessionStore, mo as callGateway, wf as loadConfig } from "./setup-wizard-helpers-BPw-E_P4.js";
import "./provider-env-vars-CWXfFyDU.js";
import "./logger-D1gzveLR.js";
import "./tmp-openclaw-dir-DgWJsVV_.js";
import { n as init_subsystem, t as createSubsystemLogger } from "./subsystem-0lZt3jI5.js";
import "./utils-DknlDzAi.js";
import "./fetch-CysqlwhH.js";
import "./retry-CyJj_oar.js";
import "./paths-BDsrA18Z.js";
import "./signal-FT4PyBH3.js";
import "./config-helpers-BQX8LEv1.js";
import "./fetch-CKhAJuFk.js";
import "./exec-DEBhRlDf.js";
import "./agent-scope-CgozsAuQ.js";
import "./reply-prefix-Dcd4HlHm.js";
import "./logger-CXkOEiRn.js";
import "./fetch-guard-DryYzke6.js";
import "./resolve-route-CPxNiUBg.js";
import "./pairing-token-ukgXF6GK.js";
import { R as resolveStorePath } from "./query-expansion-t4qzEE5Z.js";
import "./redact-DkskT6Xp.js";
import "./channel-plugin-common-Cs4waNSc.js";
import "./secret-file-CCHXecQt.js";
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
init_subsystem();
const log = createSubsystemLogger("subagent-orphan-recovery");
/** Delay before attempting recovery to let the gateway finish bootstrapping. */
const DEFAULT_RECOVERY_DELAY_MS = 5e3;
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
			log.warn(`resumed orphaned session ${params.sessionKey} but remap failed (old run already removed); treating as failure`);
			return false;
		}
		log.info(`resumed orphaned session: ${params.sessionKey}`);
		return true;
	} catch (err) {
		log.warn(`failed to resume orphaned session ${params.sessionKey}: ${String(err)}`);
		return false;
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
		skipped: 0
	};
	const resumedSessionKeys = params.resumedSessionKeys ?? /* @__PURE__ */ new Set();
	const configChangePattern = /openclaw\.json|openclaw gateway restart|config\.patch/i;
	try {
		const activeRuns = params.getActiveRuns();
		if (activeRuns.size === 0) return result;
		const cfg = loadConfig();
		const storeCache = /* @__PURE__ */ new Map();
		for (const [runId, runRecord] of activeRuns.entries()) {
			if (typeof runRecord.endedAt === "number" && runRecord.endedAt > 0) continue;
			const childSessionKey = runRecord.childSessionKey?.trim();
			if (!childSessionKey) continue;
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
				if (!entry.abortedLastRun) {
					result.skipped++;
					continue;
				}
				log.info(`found orphaned subagent session: ${childSessionKey} (run=${runId})`);
				const messages = readSessionMessages(entry.sessionId, storePath, entry.sessionFile);
				const lastHumanMessage = [...messages].toReversed().find((msg) => msg?.role === "user");
				const configChangeDetected = messages.some((msg) => {
					if (msg?.role !== "assistant") return false;
					const text = extractMessageText(msg);
					return typeof text === "string" && configChangePattern.test(text);
				});
				if (await resumeOrphanedSession({
					sessionKey: childSessionKey,
					task: runRecord.task,
					lastHumanMessage: extractMessageText(lastHumanMessage),
					configChangeHint: configChangeDetected ? "\n\n[config changes from your previous run were already applied — do not re-modify openclaw.json or restart the gateway]" : void 0,
					originalRunId: runId,
					originalRun: runRecord
				})) {
					resumedSessionKeys.add(childSessionKey);
					try {
						await updateSessionStore(storePath, (currentStore) => {
							const current = currentStore[childSessionKey];
							if (current) {
								current.abortedLastRun = false;
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
				}
			} catch (err) {
				log.warn(`error processing orphaned session ${childSessionKey}: ${String(err)}`);
				result.failed++;
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
/**
* Schedule orphan recovery after a delay, with retry logic.
* The delay gives the gateway time to fully bootstrap after restart.
* If recovery fails (e.g. gateway not yet ready), retries with exponential backoff.
*/
function scheduleOrphanRecovery(params) {
	const initialDelay = params.delayMs ?? DEFAULT_RECOVERY_DELAY_MS;
	const maxRetries = params.maxRetries ?? MAX_RECOVERY_RETRIES;
	const resumedSessionKeys = /* @__PURE__ */ new Set();
	const attemptRecovery = (attempt, delay) => {
		setTimeout(() => {
			recoverOrphanedSubagentSessions({
				...params,
				resumedSessionKeys
			}).then((result) => {
				if (result.failed > 0 && attempt < maxRetries) {
					const nextDelay = delay * RETRY_BACKOFF_MULTIPLIER;
					log.info(`orphan recovery had ${result.failed} failure(s); retrying in ${nextDelay}ms (attempt ${attempt + 1}/${maxRetries})`);
					attemptRecovery(attempt + 1, nextDelay);
				}
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
