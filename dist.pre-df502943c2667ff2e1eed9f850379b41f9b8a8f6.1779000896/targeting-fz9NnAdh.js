import { v as resolveStateDir } from "./paths-Cnwfh6dH.js";
import { a as loadPendingJsonDurableQueueEntries, c as resolveJsonDurableQueueEntryPaths, i as loadJsonDurableQueueEntry, l as writeJsonDurableQueueEntry, n as ensureJsonDurableQueueDirs, o as moveJsonDurableQueueEntryToFailed, r as jsonDurableQueueEntryExists, s as readJsonDurableQueueEntry, t as ackJsonDurableQueueEntry } from "./json-durable-queue-1BWmcBnl.js";
import { a as normalizeDiagnosticTraceparent } from "./diagnostic-trace-context-pure-BTcJKynq.js";
import "./diagnostic-trace-context-B7EOHOXE.js";
import { a as normalizeContinuationTargetKeys, i as normalizeContinuationTargetKey } from "./targeting-pure-CoyWsRK2.js";
import { a as emitContinuationFanoutSpan } from "./continuation-tracer-BgjZGLwk.js";
import { s as requestHeartbeatNow } from "./heartbeat-wake-z50YY6dQ.js";
import { o as generateSecureUuid } from "./secure-random-BlwDsoUi.js";
import { a as enqueueSystemEvent } from "./system-events-B4ot3XuJ.js";
import * as fs$1 from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
//#region src/infra/session-delivery-queue-storage.ts
const QUEUE_DIRNAME = "session-delivery-queue";
const FAILED_DIRNAME = "failed";
const TMP_SWEEP_MAX_AGE_MS = 5e3;
const QUEUE_TEMP_PREFIX = ".session-delivery-queue";
var SessionDeliveryQueueOverflowError = class extends Error {
	constructor(count, maxFiles) {
		super(`session-delivery-queue overflow: ${count} queued files at top level, soft-cap is ${maxFiles}`);
		this.kind = "session-delivery-queue-overflow";
		this.name = "SessionDeliveryQueueOverflowError";
		this.count = count;
		this.maxFiles = maxFiles;
	}
};
function getErrnoCode(err) {
	return err && typeof err === "object" && "code" in err ? String(err.code) : null;
}
function canonicalizeIdempotencyKey(key) {
	return key.replace(/[ \t\r\f\v]+(?=\n|$)/g, "").replace(/\s+$/, "");
}
function buildEntryId(idempotencyKey) {
	if (!idempotencyKey) return generateSecureUuid();
	return createHash("sha256").update(canonicalizeIdempotencyKey(idempotencyKey)).digest("hex");
}
function normalizeQueuedTraceparent(payload) {
	const normalizedTraceparent = normalizeDiagnosticTraceparent(payload.traceparent);
	const normalizedPayload = { ...payload };
	if (normalizedTraceparent) normalizedPayload.traceparent = normalizedTraceparent;
	else delete normalizedPayload.traceparent;
	return normalizedPayload;
}
function buildPostCompactionDelegateIdempotencyKey(params) {
	const taskHash = createHash("sha256").update(params.delegate.task).digest("hex").slice(0, 16);
	return [
		"post-compaction-delegate",
		params.sessionKey,
		String(params.compactionCount ?? "unknown"),
		String(params.delegate.firstArmedAt ?? params.delegate.createdAt),
		String(params.sequence),
		taskHash
	].join(":");
}
function buildPostCompactionDelegateDeliveryPayload(params) {
	return {
		kind: "postCompactionDelegate",
		sessionKey: params.sessionKey,
		task: params.delegate.task,
		createdAt: params.delegate.createdAt,
		firstArmedAt: params.delegate.firstArmedAt ?? params.delegate.createdAt,
		...params.delegate.silent != null ? { silent: params.delegate.silent } : {},
		...params.delegate.silentWake != null ? { silentWake: params.delegate.silentWake } : {},
		...params.delegate.targetSessionKey ? { targetSessionKey: params.delegate.targetSessionKey } : {},
		...params.delegate.targetSessionKeys && params.delegate.targetSessionKeys.length > 0 ? { targetSessionKeys: params.delegate.targetSessionKeys } : {},
		...params.delegate.fanoutMode ? { fanoutMode: params.delegate.fanoutMode } : {},
		...params.delegate.traceparent ? { traceparent: params.delegate.traceparent } : {},
		...params.deliveryContext ? { deliveryContext: params.deliveryContext } : {},
		idempotencyKey: params.idempotencyKey ?? buildPostCompactionDelegateIdempotencyKey({
			sessionKey: params.sessionKey,
			delegate: params.delegate,
			sequence: params.sequence,
			compactionCount: params.compactionCount
		})
	};
}
async function writeQueueEntry(filePath, entry) {
	await writeJsonDurableQueueEntry({
		filePath,
		entry,
		tempPrefix: QUEUE_TEMP_PREFIX
	});
}
async function readQueueEntry(filePath) {
	return await readJsonDurableQueueEntry(filePath);
}
function resolveSessionDeliveryQueueDir(stateDir) {
	const base = stateDir ?? resolveStateDir();
	return path.join(base, QUEUE_DIRNAME);
}
function resolveFailedDir(stateDir) {
	return path.join(resolveSessionDeliveryQueueDir(stateDir), FAILED_DIRNAME);
}
function resolveQueueEntryPaths(id, stateDir) {
	return resolveJsonDurableQueueEntryPaths(resolveSessionDeliveryQueueDir(stateDir), id);
}
async function ensureSessionDeliveryQueueDir(stateDir) {
	const queueDir = resolveSessionDeliveryQueueDir(stateDir);
	await ensureJsonDurableQueueDirs({
		queueDir,
		failedDir: resolveFailedDir(stateDir)
	});
	return queueDir;
}
async function countQueuedFiles(queueDir) {
	let entries;
	try {
		entries = await fs$1.promises.readdir(queueDir);
	} catch (err) {
		if (getErrnoCode(err) === "ENOENT") return 0;
		throw err;
	}
	let count = 0;
	for (const entry of entries) if (entry.endsWith(".json") || entry.endsWith(".tmp") || entry.endsWith(".delivered")) count += 1;
	return count;
}
async function enqueueSessionDelivery(params, stateDir, opts) {
	const payload = normalizeQueuedTraceparent(params);
	const queueDir = await ensureSessionDeliveryQueueDir(stateDir);
	const id = buildEntryId(payload.idempotencyKey);
	const filePath = path.join(queueDir, `${id}.json`);
	if (payload.idempotencyKey) {
		if (await jsonDurableQueueEntryExists(filePath)) return id;
	}
	const maxQueuedFiles = opts?.maxQueuedFiles ?? 1e4;
	if (Number.isFinite(maxQueuedFiles) && maxQueuedFiles > 0) {
		const count = await countQueuedFiles(queueDir);
		if (count >= maxQueuedFiles) {
			console.warn(`[session-delivery-queue] enqueue rejected: ${count} queued files at top level, soft-cap is ${maxQueuedFiles}`);
			throw new SessionDeliveryQueueOverflowError(count, maxQueuedFiles);
		}
	}
	await writeQueueEntry(filePath, {
		...payload,
		id,
		enqueuedAt: Date.now(),
		retryCount: 0
	});
	return id;
}
async function enqueuePostCompactionDelegateDelivery(params, stateDir, opts) {
	return await enqueueSessionDelivery(buildPostCompactionDelegateDeliveryPayload(params), stateDir, opts);
}
async function ackSessionDelivery(id, stateDir) {
	await ackJsonDurableQueueEntry(resolveQueueEntryPaths(id, stateDir));
}
async function failSessionDelivery(id, error, stateDir) {
	const filePath = path.join(resolveSessionDeliveryQueueDir(stateDir), `${id}.json`);
	const entry = await readQueueEntry(filePath);
	entry.retryCount += 1;
	entry.lastAttemptAt = Date.now();
	entry.lastError = error;
	await writeQueueEntry(filePath, entry);
}
async function loadPendingSessionDelivery(id, stateDir) {
	return await loadJsonDurableQueueEntry({
		paths: resolveQueueEntryPaths(id, stateDir),
		tempPrefix: QUEUE_TEMP_PREFIX
	});
}
async function loadPendingSessionDeliveries(stateDir) {
	return await loadPendingJsonDurableQueueEntries({
		queueDir: resolveSessionDeliveryQueueDir(stateDir),
		tempPrefix: QUEUE_TEMP_PREFIX,
		cleanupTmpMaxAgeMs: TMP_SWEEP_MAX_AGE_MS
	});
}
async function moveSessionDeliveryToFailed(id, stateDir) {
	await moveJsonDurableQueueEntryToFailed({
		queueDir: resolveSessionDeliveryQueueDir(stateDir),
		failedDir: resolveFailedDir(stateDir),
		id
	});
}
async function pruneFailedOlderThan(maxAgeMs, now, stateDir) {
	const failedDir = resolveFailedDir(stateDir);
	let entries;
	try {
		entries = await fs$1.promises.readdir(failedDir);
	} catch (err) {
		if (getErrnoCode(err) === "ENOENT") return {
			scanned: 0,
			removed: 0
		};
		throw err;
	}
	let scanned = 0;
	let removed = 0;
	for (const entry of entries) {
		const filePath = path.join(failedDir, entry);
		try {
			const stat = await fs$1.promises.stat(filePath);
			if (!stat.isFile()) continue;
			scanned += 1;
			if (now - stat.mtimeMs > maxAgeMs) try {
				await fs$1.promises.unlink(filePath);
				removed += 1;
			} catch (unlinkErr) {
				if (getErrnoCode(unlinkErr) !== "ENOENT") throw unlinkErr;
			}
		} catch (err) {
			if (getErrnoCode(err) === "ENOENT") continue;
			throw err;
		}
	}
	return {
		scanned,
		removed
	};
}
//#endregion
//#region src/auto-reply/continuation/targeting.ts
function resolveContinuationReturnTargetSessionKeys(params) {
	const defaultSessionKey = normalizeContinuationTargetKey(params.defaultSessionKey);
	const fallback = defaultSessionKey ? [defaultSessionKey] : [];
	if (params.fanoutMode === "tree") {
		const treeKeys = normalizeContinuationTargetKeys(params.treeSessionKeys);
		return treeKeys.length > 0 ? treeKeys : fallback;
	}
	if (params.fanoutMode === "all") {
		const childSessionKey = normalizeContinuationTargetKey(params.childSessionKey);
		const allKeys = normalizeContinuationTargetKeys(params.allSessionKeys).filter((sessionKey) => sessionKey !== childSessionKey);
		return allKeys.length > 0 ? allKeys : fallback;
	}
	const explicitKeys = normalizeContinuationTargetKeys([...params.targetSessionKey ? [params.targetSessionKey] : [], ...params.targetSessionKeys ?? []]);
	return explicitKeys.length > 0 ? explicitKeys : fallback;
}
const defaultContinuationReturnDeliveryDeps = {
	enqueueSessionDelivery,
	ackSessionDelivery,
	enqueueSystemEvent,
	requestHeartbeatNow
};
async function enqueueContinuationReturnDeliveries(params, deps = defaultContinuationReturnDeliveryDeps) {
	const targetSessionKeys = normalizeContinuationTargetKeys(params.targetSessionKeys);
	const deliveryIds = [];
	let delivered = 0;
	for (const [index, sessionKey] of targetSessionKeys.entries()) {
		const deliveryId = await deps.enqueueSessionDelivery({
			kind: "systemEvent",
			sessionKey,
			text: params.text,
			...params.deliveryContext ? { deliveryContext: params.deliveryContext } : {},
			...params.traceparent ? { traceparent: params.traceparent } : {},
			idempotencyKey: `${params.idempotencyKeyBase}:${index}:${sessionKey}`
		}, params.stateDir);
		deliveryIds.push(deliveryId);
		deps.enqueueSystemEvent(params.text, {
			sessionKey,
			trusted: true,
			...params.deliveryContext ? { deliveryContext: params.deliveryContext } : {},
			...params.traceparent ? { traceparent: params.traceparent } : {}
		});
		if (params.wakeRecipients) deps.requestHeartbeatNow({
			sessionKey,
			reason: "delegate-return",
			parentRunId: params.childRunId
		});
		delivered += 1;
	}
	if ((params.traceparent !== void 0 || params.chainStepRemaining !== void 0) && (params.fanoutMode !== void 0 || targetSessionKeys.length > 1)) emitContinuationFanoutSpan({
		targetSessionKeys,
		deliveredCount: delivered,
		...params.fanoutMode ? { fanoutMode: params.fanoutMode } : {},
		...params.chainStepRemaining !== void 0 ? { chainStepRemaining: params.chainStepRemaining } : {},
		...params.traceparent ? { traceparent: params.traceparent } : {}
	});
	return {
		enqueued: deliveryIds.length,
		delivered,
		deliveryIds
	};
}
//#endregion
export { enqueueSessionDelivery as a, loadPendingSessionDelivery as c, enqueuePostCompactionDelegateDelivery as i, moveSessionDeliveryToFailed as l, resolveContinuationReturnTargetSessionKeys as n, failSessionDelivery as o, ackSessionDelivery as r, loadPendingSessionDeliveries as s, enqueueContinuationReturnDeliveries as t, pruneFailedOlderThan as u };
