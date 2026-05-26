import { y as resolveStateDir } from "./paths-Cw7f9XhU.js";
import { a as isSubagentSessionKey, i as isCronSessionKey, n as isAcpSessionKey } from "./session-key-utils-Ce_xWkNq.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { r as callGateway } from "./call-t1U2G3yY.js";
import { i as resolveSessionFilePath, s as resolveSessionTranscriptPathInDir } from "./paths-Bg3PO6Gj.js";
import { t as loadSessionStore } from "./store-load-z4thf6ld.js";
import { u as updateSessionStore } from "./store-BmtchQvp.js";
import { t as resolveAgentSessionDirs } from "./session-dirs-Dmxb0Dxh.js";
import { i as resolveAllAgentSessionStoreTargetsSync } from "./targets-B5o7Ubgb.js";
import "./sessions-CQHHcgC_.js";
import { l as readSessionMessagesAsync } from "./session-utils.fs-CsnHXIqH.js";
import { t as sanitizePendingFinalDeliveryText } from "./pending-final-delivery-yO5vCTL4.js";
import { m as resolveGatewaySessionStoreTarget } from "./session-utils-CRKr-5AU.js";
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
function normalizeStringSet(values) {
	const normalized = /* @__PURE__ */ new Set();
	for (const value of values ?? []) {
		const trimmed = value.trim();
		if (trimmed) normalized.add(trimmed);
	}
	return normalized;
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
async function markRestartAbortedMainSessions(params) {
	const sessionKeys = normalizeStringSet(params.sessionKeys);
	const sessionIds = normalizeStringSet(params.sessionIds);
	const preferSessionIdMatch = sessionIds.size > 0;
	const result = {
		marked: 0,
		skipped: 0
	};
	if (sessionKeys.size === 0 && sessionIds.size === 0) return result;
	const storePaths = /* @__PURE__ */ new Set();
	const env = params.stateDir === void 0 ? process.env : {
		...process.env,
		OPENCLAW_STATE_DIR: params.stateDir
	};
	const stateDir = resolveStateDir(env);
	const configs = [params.cfg, ...params.additionalCfgs ?? []].filter((cfg) => Boolean(cfg));
	for (const cfg of configs) {
		try {
			for (const target of resolveAllAgentSessionStoreTargetsSync(cfg, { env })) storePaths.add(path.resolve(target.storePath));
		} catch (err) {
			log.warn(`failed to resolve configured session stores for restart marker: ${String(err)}`);
		}
		for (const sessionKey of sessionKeys) try {
			const target = resolveGatewaySessionStoreTarget({
				cfg,
				key: sessionKey,
				scanLegacyKeys: true
			});
			storePaths.add(path.resolve(target.storePath));
			for (const storeKey of target.storeKeys) {
				const trimmed = storeKey.trim();
				if (trimmed) sessionKeys.add(trimmed);
			}
		} catch (err) {
			log.warn(`failed to resolve session store for restart marker ${sessionKey}: ${String(err)}`);
		}
	}
	for (const sessionsDir of await resolveAgentSessionDirs(stateDir)) storePaths.add(path.join(sessionsDir, "sessions.json"));
	for (const storePath of storePaths) await updateSessionStore(storePath, (store) => {
		for (const [sessionKey, entry] of Object.entries(store)) {
			if (!entry || entry.status !== "running") continue;
			if (!(typeof entry.sessionId === "string" && sessionIds.has(entry.sessionId) ? true : !preferSessionIdMatch && sessionKeys.has(sessionKey))) continue;
			if (shouldSkipMainRecovery(entry, sessionKey)) {
				result.skipped++;
				continue;
			}
			entry.abortedLastRun = true;
			entry.updatedAt = Date.now();
			store[sessionKey] = entry;
			result.marked++;
		}
	}, { skipMaintenance: true });
	if (result.marked > 0) log.warn(`marked ${result.marked} interrupted main session(s) for restart recovery${params.reason ? ` (${params.reason})` : ""}`);
	return result;
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
function buildResumeMessage(pendingFinalDeliveryText) {
	const base = "[System] Your previous turn was interrupted by a gateway restart while OpenClaw was waiting on tool/model work. Continue from the existing transcript and finish the interrupted response.";
	const sanitizedPendingText = typeof pendingFinalDeliveryText === "string" ? sanitizePendingFinalDeliveryText(pendingFinalDeliveryText) : "";
	if (sanitizedPendingText) return `${base}\n\nNote: The interrupted final reply was captured: "${sanitizedPendingText}"`;
	return base;
}
async function markSessionFailed(params) {
	await updateSessionStore(params.storePath, (store) => {
		const entry = store[params.sessionKey];
		if (!entry || entry.status !== "running") return;
		entry.status = "failed";
		entry.abortedLastRun = true;
		entry.endedAt = Date.now();
		entry.updatedAt = entry.endedAt;
		entry.pendingFinalDelivery = void 0;
		entry.pendingFinalDeliveryText = void 0;
		entry.pendingFinalDeliveryCreatedAt = void 0;
		entry.pendingFinalDeliveryLastAttemptAt = void 0;
		entry.pendingFinalDeliveryAttemptCount = void 0;
		entry.pendingFinalDeliveryLastError = void 0;
		entry.pendingFinalDeliveryContext = void 0;
		store[params.sessionKey] = entry;
	}, { skipMaintenance: true });
	log.warn(`marked interrupted main session failed: ${params.sessionKey} (${params.reason})`);
}
async function resumeMainSession(params) {
	const sanitizedPendingText = typeof params.pendingFinalDeliveryText === "string" ? sanitizePendingFinalDeliveryText(params.pendingFinalDeliveryText) : "";
	try {
		await callGateway({
			method: "agent",
			params: {
				message: buildResumeMessage(sanitizedPendingText),
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
			const now = Date.now();
			entry.abortedLastRun = false;
			entry.updatedAt = now;
			if (entry.pendingFinalDelivery || entry.pendingFinalDeliveryText) if (sanitizedPendingText) {
				entry.pendingFinalDeliveryLastAttemptAt = now;
				entry.pendingFinalDeliveryAttemptCount = (entry.pendingFinalDeliveryAttemptCount ?? 0) + 1;
				entry.pendingFinalDeliveryLastError = null;
				entry.pendingFinalDeliveryText = sanitizedPendingText;
			} else {
				entry.pendingFinalDelivery = void 0;
				entry.pendingFinalDeliveryText = void 0;
				entry.pendingFinalDeliveryCreatedAt = void 0;
				entry.pendingFinalDeliveryLastAttemptAt = void 0;
				entry.pendingFinalDeliveryAttemptCount = void 0;
				entry.pendingFinalDeliveryLastError = void 0;
				entry.pendingFinalDeliveryContext = void 0;
			}
			store[params.sessionKey] = entry;
		}, { skipMaintenance: true });
		log.info(`resumed interrupted main session: ${params.sessionKey}${sanitizedPendingText ? " (with pending payload)" : ""}`);
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
			sessionKey,
			pendingFinalDeliveryText: entry.pendingFinalDeliveryText
		})) {
			params.resumedSessionKeys.add(sessionKey);
			result.recovered++;
		} else result.failed++;
	}
	return result;
}
async function resolveRestartRecoveryStorePaths(params) {
	const storePaths = /* @__PURE__ */ new Set();
	const stateDir = params.stateDir ?? resolveStateDir(process.env);
	for (const sessionsDir of await resolveAgentSessionDirs(stateDir)) storePaths.add(path.join(sessionsDir, "sessions.json"));
	if (params.cfg) {
		const env = {
			...process.env,
			OPENCLAW_STATE_DIR: stateDir
		};
		for (const target of resolveAllAgentSessionStoreTargetsSync(params.cfg, { env })) storePaths.add(path.resolve(target.storePath));
	}
	return [...storePaths].toSorted((a, b) => a.localeCompare(b));
}
async function recoverRestartAbortedMainSessions(params = {}) {
	const result = {
		recovered: 0,
		failed: 0,
		skipped: 0
	};
	const resumedSessionKeys = params.resumedSessionKeys ?? /* @__PURE__ */ new Set();
	for (const storePath of await resolveRestartRecoveryStorePaths(params)) {
		const storeResult = await recoverStore({
			storePath,
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
				cfg: params.cfg,
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
export { scheduleRestartAbortedMainSessionRecovery as i, markRestartAbortedMainSessionsFromLocks as n, recoverRestartAbortedMainSessions as r, markRestartAbortedMainSessions as t };
