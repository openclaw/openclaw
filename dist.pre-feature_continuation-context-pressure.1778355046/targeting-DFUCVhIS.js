import { v as resolveStateDir } from "./paths-C1_Y0cDn.js";
import { n as normalizeContinuationTargetKey, r as normalizeContinuationTargetKeys } from "./targeting-pure-X9w5LSlN.js";
import { o as generateSecureUuid } from "./secure-random-UYE7uWu5.js";
import { a as emitContinuationFanoutSpan } from "./continuation-tracer-BBwQ5F_5.js";
import { s as requestHeartbeatNow } from "./heartbeat-wake-Ch63UKbi.js";
import { a as enqueueSystemEvent } from "./system-events-CoCLzqF0.js";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
//#region src/infra/session-delivery-queue-storage.ts
const QUEUE_DIRNAME = "session-delivery-queue";
const FAILED_DIRNAME = "failed";
const TMP_SWEEP_MAX_AGE_MS = 5e3;
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
		...params.delegate.attachments && params.delegate.attachments.length > 0 ? { attachments: params.delegate.attachments } : {},
		...params.delegate.attachAs ? { attachAs: params.delegate.attachAs } : {},
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
async function unlinkBestEffort(filePath) {
	await fs.promises.unlink(filePath).catch(() => void 0);
}
async function unlinkStaleTmpBestEffort(filePath, now) {
	try {
		const stat = await fs.promises.stat(filePath);
		if (!stat.isFile()) return;
		if (now - stat.mtimeMs < TMP_SWEEP_MAX_AGE_MS) return;
		await unlinkBestEffort(filePath);
	} catch (err) {
		if (getErrnoCode(err) !== "ENOENT") throw err;
	}
}
async function writeQueueEntry(filePath, entry) {
	const tmp = `${filePath}.${process.pid}.tmp`;
	await fs.promises.writeFile(tmp, JSON.stringify(entry, null, 2), {
		encoding: "utf-8",
		mode: 384
	});
	await fs.promises.rename(tmp, filePath);
}
async function readQueueEntry(filePath) {
	return JSON.parse(await fs.promises.readFile(filePath, "utf-8"));
}
function resolveSessionDeliveryQueueDir(stateDir) {
	const base = stateDir ?? resolveStateDir();
	return path.join(base, QUEUE_DIRNAME);
}
function resolveFailedDir(stateDir) {
	return path.join(resolveSessionDeliveryQueueDir(stateDir), FAILED_DIRNAME);
}
function resolveQueueEntryPaths(id, stateDir) {
	const queueDir = resolveSessionDeliveryQueueDir(stateDir);
	return {
		jsonPath: path.join(queueDir, `${id}.json`),
		deliveredPath: path.join(queueDir, `${id}.delivered`)
	};
}
async function ensureSessionDeliveryQueueDir(stateDir) {
	const queueDir = resolveSessionDeliveryQueueDir(stateDir);
	await fs.promises.mkdir(queueDir, {
		recursive: true,
		mode: 448
	});
	await fs.promises.mkdir(resolveFailedDir(stateDir), {
		recursive: true,
		mode: 448
	});
	return queueDir;
}
async function countQueuedFiles(queueDir) {
	let entries;
	try {
		entries = await fs.promises.readdir(queueDir);
	} catch (err) {
		if (getErrnoCode(err) === "ENOENT") return 0;
		throw err;
	}
	let count = 0;
	for (const entry of entries) if (entry.endsWith(".json") || entry.endsWith(".tmp") || entry.endsWith(".delivered")) count += 1;
	return count;
}
async function enqueueSessionDelivery(params, stateDir, opts) {
	const queueDir = await ensureSessionDeliveryQueueDir(stateDir);
	const id = buildEntryId(params.idempotencyKey);
	const filePath = path.join(queueDir, `${id}.json`);
	if (params.idempotencyKey) try {
		if ((await fs.promises.stat(filePath)).isFile()) return id;
	} catch (err) {
		if (getErrnoCode(err) !== "ENOENT") throw err;
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
		...params,
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
	const { jsonPath, deliveredPath } = resolveQueueEntryPaths(id, stateDir);
	try {
		await fs.promises.rename(jsonPath, deliveredPath);
	} catch (err) {
		if (getErrnoCode(err) === "ENOENT") {
			await unlinkBestEffort(deliveredPath);
			return;
		}
		throw err;
	}
	await unlinkBestEffort(deliveredPath);
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
	const { jsonPath } = resolveQueueEntryPaths(id, stateDir);
	try {
		if (!(await fs.promises.stat(jsonPath)).isFile()) return null;
		return await readQueueEntry(jsonPath);
	} catch (err) {
		if (getErrnoCode(err) === "ENOENT") return null;
		throw err;
	}
}
async function loadPendingSessionDeliveries(stateDir) {
	const queueDir = resolveSessionDeliveryQueueDir(stateDir);
	let files;
	try {
		files = await fs.promises.readdir(queueDir);
	} catch (err) {
		if (getErrnoCode(err) === "ENOENT") return [];
		throw err;
	}
	const now = Date.now();
	for (const file of files) if (file.endsWith(".delivered")) await unlinkBestEffort(path.join(queueDir, file));
	else if (file.endsWith(".tmp")) await unlinkStaleTmpBestEffort(path.join(queueDir, file), now);
	const entries = [];
	for (const file of files) {
		if (!file.endsWith(".json")) continue;
		const filePath = path.join(queueDir, file);
		try {
			if (!(await fs.promises.stat(filePath)).isFile()) continue;
			entries.push(await readQueueEntry(filePath));
		} catch {
			continue;
		}
	}
	return entries;
}
async function moveSessionDeliveryToFailed(id, stateDir) {
	const queueDir = resolveSessionDeliveryQueueDir(stateDir);
	const failedDir = resolveFailedDir(stateDir);
	await fs.promises.mkdir(failedDir, {
		recursive: true,
		mode: 448
	});
	await fs.promises.rename(path.join(queueDir, `${id}.json`), path.join(failedDir, `${id}.json`));
}
async function pruneFailedOlderThan(maxAgeMs, now, stateDir) {
	const failedDir = resolveFailedDir(stateDir);
	let entries;
	try {
		entries = await fs.promises.readdir(failedDir);
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
			const stat = await fs.promises.stat(filePath);
			if (!stat.isFile()) continue;
			scanned += 1;
			if (now - stat.mtimeMs > maxAgeMs) try {
				await fs.promises.unlink(filePath);
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
