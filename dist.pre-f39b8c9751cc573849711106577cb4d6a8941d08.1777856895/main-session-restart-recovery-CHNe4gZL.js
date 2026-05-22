import { v as resolveStateDir } from "./paths-C1_Y0cDn.js";
import { t as createSubsystemLogger } from "./subsystem-CgTF-J8V.js";
import { a as isSubagentSessionKey, i as isCronSessionKey, n as isAcpSessionKey } from "./session-key-utils-Dnbck33i.js";
import { i as resolveSessionFilePath, s as resolveSessionTranscriptPathInDir } from "./paths-CJq5T6t4.js";
import { t as loadSessionStore } from "./store-load-CPVa0fsE.js";
import { t as resolveAgentSessionDirs } from "./session-dirs-LBppM1OR.js";
import { o as updateSessionStore } from "./store-C0WV070A.js";
import "./sessions-hf7PWp-q.js";
import { i as callGateway } from "./call-Bo0kEGD9.js";
import { l as readSessionMessagesAsync } from "./session-utils.fs-D59mRZNQ.js";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
//#region src/agents/main-session-restart-recovery.ts
/**
* Post-restart recovery for main sessions interrupted while holding a transcript lock.
*/
const log = createSubsystemLogger("main-session-restart-recovery");
const DEFAULT_RECOVERY_DELAY_MS = 5e3;
const MAX_RECOVERY_RETRIES = 3;
const RETRY_BACKOFF_MULTIPLIER = 2;
function shouldSkipMainRecovery(entry, sessionKey) {
	if (typeof entry.spawnDepth === "number" && entry.spawnDepth > 0) return true;
	if (entry.subagentRole != null) return true;
	return isSubagentSessionKey(sessionKey) || isCronSessionKey(sessionKey) || isAcpSessionKey(sessionKey);
}
function normalizeTranscriptLockPath(lockPath) {
	const trimmed = lockPath.trim();
	if (!path.basename(trimmed).endsWith(".jsonl.lock")) return;
	const resolved = path.resolve(trimmed);
	try {
		return path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved));
	} catch {
		return resolved;
	}
}
function resolveEntryTranscriptLockPaths(params) {
	const paths = /* @__PURE__ */ new Set();
	const push = (resolvePath) => {
		try {
			paths.add(path.resolve(`${resolvePath()}.lock`));
		} catch {}
	};
	push(() => resolveSessionFilePath(params.entry.sessionId, params.entry, { sessionsDir: params.sessionsDir }));
	push(() => resolveSessionTranscriptPathInDir(params.entry.sessionId, params.sessionsDir));
	return [...paths];
}
function getMessageRole(message) {
	if (!message || typeof message !== "object") return;
	const role = message.role;
	return typeof role === "string" ? role : void 0;
}
function isMeaningfulTailMessage(message) {
	const role = getMessageRole(message);
	if (!role || role === "system") return false;
	return true;
}
function isResumableTailMessage(message) {
	const role = getMessageRole(message);
	return role === "user" || role === "tool" || role === "toolResult";
}
function isApprovalPendingToolResult(message) {
	if (!message || typeof message !== "object" || getMessageRole(message) !== "toolResult") return false;
	const details = message.details;
	if (!details || typeof details !== "object") return false;
	return details.status === "approval-pending";
}
function resolveMainSessionResumeBlockReason(messages) {
	const lastMeaningful = messages.toReversed().find(isMeaningfulTailMessage);
	if (!lastMeaningful || !isResumableTailMessage(lastMeaningful)) return "transcript tail is not resumable";
	if (isApprovalPendingToolResult(lastMeaningful)) return "transcript tail is a stale approval-pending tool result";
	return null;
}
function buildResumeMessage() {
	return "[System] Your previous turn was interrupted by a gateway restart while OpenClaw was waiting on tool/model work. Continue from the existing transcript and finish the interrupted response.";
}
async function markSessionFailed(params) {
	await updateSessionStore(params.storePath, (store) => {
		const entry = store[params.sessionKey];
		if (!entry || entry.status !== "running") return;
		entry.status = "failed";
		entry.abortedLastRun = true;
		entry.endedAt = Date.now();
		entry.updatedAt = entry.endedAt;
		store[params.sessionKey] = entry;
	}, { skipMaintenance: true });
	log.warn(`marked interrupted main session failed: ${params.sessionKey} (${params.reason})`);
}
async function resumeMainSession(params) {
	try {
		await callGateway({
			method: "agent",
			params: {
				message: buildResumeMessage(),
				sessionKey: params.sessionKey,
				idempotencyKey: crypto.randomUUID(),
				deliver: false,
				lane: "main"
			},
			timeoutMs: 1e4
		});
		await updateSessionStore(params.storePath, (store) => {
			const entry = store[params.sessionKey];
			if (!entry) return;
			entry.abortedLastRun = false;
			entry.updatedAt = Date.now();
			store[params.sessionKey] = entry;
		}, { skipMaintenance: true });
		log.info(`resumed interrupted main session: ${params.sessionKey}`);
		return true;
	} catch (err) {
		log.warn(`failed to resume interrupted main session ${params.sessionKey}: ${String(err)}`);
		return false;
	}
}
async function markRestartAbortedMainSessionsFromLocks(params) {
	const result = {
		marked: 0,
		skipped: 0
	};
	const sessionsDir = path.resolve(params.sessionsDir);
	const interruptedLockPaths = new Set(params.cleanedLocks.map((lock) => normalizeTranscriptLockPath(lock.lockPath)).filter((lockPath) => Boolean(lockPath)));
	if (interruptedLockPaths.size === 0) return result;
	await updateSessionStore(path.join(sessionsDir, "sessions.json"), (store) => {
		for (const [sessionKey, entry] of Object.entries(store)) {
			if (!entry || entry.status !== "running") continue;
			if (shouldSkipMainRecovery(entry, sessionKey)) {
				result.skipped++;
				continue;
			}
			if (!resolveEntryTranscriptLockPaths({
				entry,
				sessionsDir
			}).some((lockPath) => interruptedLockPaths.has(lockPath))) continue;
			entry.abortedLastRun = true;
			store[sessionKey] = entry;
			result.marked++;
		}
	}, { skipMaintenance: true });
	if (result.marked > 0) log.warn(`marked ${result.marked} interrupted main session(s) from stale transcript locks`);
	return result;
}
async function recoverStore(params) {
	const result = {
		recovered: 0,
		failed: 0,
		skipped: 0
	};
	let store;
	try {
		store = loadSessionStore(params.storePath);
	} catch (err) {
		log.warn(`failed to load session store ${params.storePath}: ${String(err)}`);
		result.failed++;
		return result;
	}
	for (const [sessionKey, entry] of Object.entries(store).toSorted(([a], [b]) => a.localeCompare(b))) {
		if (!entry || entry.status !== "running" || entry.abortedLastRun !== true) continue;
		if (shouldSkipMainRecovery(entry, sessionKey)) {
			result.skipped++;
			continue;
		}
		if (params.resumedSessionKeys.has(sessionKey)) {
			result.skipped++;
			continue;
		}
		let messages;
		try {
			messages = await readSessionMessagesAsync(entry.sessionId, params.storePath, entry.sessionFile, {
				mode: "recent",
				maxMessages: 20,
				maxBytes: 256 * 1024
			});
		} catch (err) {
			log.warn(`failed to read transcript for ${sessionKey}: ${String(err)}`);
			result.failed++;
			continue;
		}
		const resumeBlockReason = resolveMainSessionResumeBlockReason(messages);
		if (resumeBlockReason) {
			await markSessionFailed({
				storePath: params.storePath,
				sessionKey,
				reason: resumeBlockReason
			});
			result.failed++;
			continue;
		}
		if (await resumeMainSession({
			storePath: params.storePath,
			sessionKey
		})) {
			params.resumedSessionKeys.add(sessionKey);
			result.recovered++;
		} else result.failed++;
	}
	return result;
}
async function recoverRestartAbortedMainSessions(params = {}) {
	const result = {
		recovered: 0,
		failed: 0,
		skipped: 0
	};
	const resumedSessionKeys = params.resumedSessionKeys ?? /* @__PURE__ */ new Set();
	const sessionDirs = await resolveAgentSessionDirs(params.stateDir ?? resolveStateDir(process.env));
	for (const sessionsDir of sessionDirs) {
		const storeResult = await recoverStore({
			storePath: path.join(sessionsDir, "sessions.json"),
			resumedSessionKeys
		});
		result.recovered += storeResult.recovered;
		result.failed += storeResult.failed;
		result.skipped += storeResult.skipped;
	}
	if (result.recovered > 0 || result.failed > 0) log.info(`main-session restart recovery complete: recovered=${result.recovered} failed=${result.failed} skipped=${result.skipped}`);
	return result;
}
function scheduleRestartAbortedMainSessionRecovery(params = {}) {
	const initialDelay = params.delayMs ?? DEFAULT_RECOVERY_DELAY_MS;
	const maxRetries = params.maxRetries ?? MAX_RECOVERY_RETRIES;
	const resumedSessionKeys = /* @__PURE__ */ new Set();
	const attemptRecovery = (attempt, delay) => {
		setTimeout(() => {
			recoverRestartAbortedMainSessions({
				stateDir: params.stateDir,
				resumedSessionKeys
			}).then((result) => {
				if (result.failed > 0 && attempt < maxRetries) attemptRecovery(attempt + 1, delay * RETRY_BACKOFF_MULTIPLIER);
			}).catch((err) => {
				if (attempt < maxRetries) {
					log.warn(`main-session restart recovery failed: ${String(err)}`);
					attemptRecovery(attempt + 1, delay * RETRY_BACKOFF_MULTIPLIER);
				} else log.warn(`main-session restart recovery gave up: ${String(err)}`);
			});
		}, delay).unref?.();
	};
	attemptRecovery(1, initialDelay);
}
//#endregion
export { markRestartAbortedMainSessionsFromLocks, scheduleRestartAbortedMainSessionRecovery };
