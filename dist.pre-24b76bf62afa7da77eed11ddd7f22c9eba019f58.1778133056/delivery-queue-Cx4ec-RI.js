import { v as resolveStateDir } from "./paths-C1_Y0cDn.js";
import { i as formatErrorMessage } from "./errors-QN8rySzW.js";
import { o as generateSecureUuid } from "./secure-random-DJM7QqXq.js";
import fs from "node:fs";
import path from "node:path";
//#region src/infra/outbound/delivery-queue-storage.ts
const QUEUE_DIRNAME = "delivery-queue";
const FAILED_DIRNAME = "failed";
function resolveQueueDir(stateDir) {
	const base = stateDir ?? resolveStateDir();
	return path.join(base, QUEUE_DIRNAME);
}
function resolveFailedDir(stateDir) {
	return path.join(resolveQueueDir(stateDir), FAILED_DIRNAME);
}
function resolveQueueEntryPaths(id, stateDir) {
	const queueDir = resolveQueueDir(stateDir);
	return {
		jsonPath: path.join(queueDir, `${id}.json`),
		deliveredPath: path.join(queueDir, `${id}.delivered`)
	};
}
function getErrnoCode$1(err) {
	return err && typeof err === "object" && "code" in err ? String(err.code) : null;
}
async function unlinkBestEffort(filePath) {
	try {
		await fs.promises.unlink(filePath);
	} catch {}
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
function normalizeLegacyQueuedDeliveryEntry(entry) {
	if (typeof entry.lastAttemptAt === "number" && Number.isFinite(entry.lastAttemptAt) && entry.lastAttemptAt > 0 || entry.retryCount <= 0) return {
		entry,
		migrated: false
	};
	if (!(typeof entry.enqueuedAt === "number" && Number.isFinite(entry.enqueuedAt) && entry.enqueuedAt > 0)) return {
		entry,
		migrated: false
	};
	return {
		entry: {
			...entry,
			lastAttemptAt: entry.enqueuedAt
		},
		migrated: true
	};
}
/** Ensure the queue directory (and failed/ subdirectory) exist. */
async function ensureQueueDir(stateDir) {
	const queueDir = resolveQueueDir(stateDir);
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
/** Persist a delivery entry to disk before attempting send. Returns the entry ID. */
async function enqueueDelivery(params, stateDir) {
	const queueDir = await ensureQueueDir(stateDir);
	const id = generateSecureUuid();
	await writeQueueEntry(path.join(queueDir, `${id}.json`), {
		id,
		enqueuedAt: Date.now(),
		channel: params.channel,
		to: params.to,
		accountId: params.accountId,
		payloads: params.payloads,
		threadId: params.threadId,
		replyToId: params.replyToId,
		replyToMode: params.replyToMode,
		formatting: params.formatting,
		bestEffort: params.bestEffort,
		gifPlayback: params.gifPlayback,
		forceDocument: params.forceDocument,
		silent: params.silent,
		mirror: params.mirror,
		session: params.session,
		gatewayClientScopes: params.gatewayClientScopes,
		retryCount: 0
	});
	return id;
}
/** Remove a successfully delivered entry from the queue.
*
* Uses a two-phase approach so that a crash between delivery and cleanup
* does not cause the message to be replayed on the next recovery scan:
*   Phase 1: atomic rename  {id}.json → {id}.delivered
*   Phase 2: unlink the .delivered marker
* If the process dies between phase 1 and phase 2 the marker is cleaned up
* by {@link loadPendingDeliveries} on the next startup without re-sending.
*/
async function ackDelivery(id, stateDir) {
	const { jsonPath, deliveredPath } = resolveQueueEntryPaths(id, stateDir);
	try {
		await fs.promises.rename(jsonPath, deliveredPath);
	} catch (err) {
		if (getErrnoCode$1(err) === "ENOENT") {
			await unlinkBestEffort(deliveredPath);
			return;
		}
		throw err;
	}
	await unlinkBestEffort(deliveredPath);
}
/** Update a queue entry after a failed delivery attempt. */
async function failDelivery(id, error, stateDir) {
	const filePath = path.join(resolveQueueDir(stateDir), `${id}.json`);
	const entry = await readQueueEntry(filePath);
	entry.retryCount += 1;
	entry.lastAttemptAt = Date.now();
	entry.lastError = error;
	await writeQueueEntry(filePath, entry);
}
/** Load a single pending delivery entry by ID from the queue directory. */
async function loadPendingDelivery(id, stateDir) {
	const { jsonPath } = resolveQueueEntryPaths(id, stateDir);
	try {
		if (!(await fs.promises.stat(jsonPath)).isFile()) return null;
		const { entry, migrated } = normalizeLegacyQueuedDeliveryEntry(await readQueueEntry(jsonPath));
		if (migrated) await writeQueueEntry(jsonPath, entry);
		return entry;
	} catch (err) {
		if (getErrnoCode$1(err) === "ENOENT") return null;
		throw err;
	}
}
/** Load all pending delivery entries from the queue directory. */
async function loadPendingDeliveries(stateDir) {
	const queueDir = resolveQueueDir(stateDir);
	let files;
	try {
		files = await fs.promises.readdir(queueDir);
	} catch (err) {
		if (getErrnoCode$1(err) === "ENOENT") return [];
		throw err;
	}
	for (const file of files) if (file.endsWith(".delivered")) await unlinkBestEffort(path.join(queueDir, file));
	const entries = [];
	for (const file of files) {
		if (!file.endsWith(".json")) continue;
		const filePath = path.join(queueDir, file);
		try {
			if (!(await fs.promises.stat(filePath)).isFile()) continue;
			const { entry, migrated } = normalizeLegacyQueuedDeliveryEntry(await readQueueEntry(filePath));
			if (migrated) await writeQueueEntry(filePath, entry);
			entries.push(entry);
		} catch {}
	}
	return entries;
}
/** Move a queue entry to the failed/ subdirectory. */
async function moveToFailed(id, stateDir) {
	const queueDir = resolveQueueDir(stateDir);
	const failedDir = resolveFailedDir(stateDir);
	await fs.promises.mkdir(failedDir, {
		recursive: true,
		mode: 448
	});
	await fs.promises.rename(path.join(queueDir, `${id}.json`), path.join(failedDir, `${id}.json`));
}
/** Backoff delays in milliseconds indexed by retry count (1-based). */
const BACKOFF_MS = [
	5e3,
	25e3,
	12e4,
	6e5
];
const PERMANENT_ERROR_PATTERNS = [
	/no conversation reference found/i,
	/chat not found/i,
	/user not found/i,
	/bot.*not.*member/i,
	/bot was blocked by the user/i,
	/forbidden: bot was kicked/i,
	/chat_id is empty/i,
	/recipient is not a valid/i,
	/outbound not configured for channel/i,
	/ambiguous .* recipient/i,
	/User .* not in room/i
];
const drainInProgress = /* @__PURE__ */ new Map();
const entriesInProgress = /* @__PURE__ */ new Set();
function getErrnoCode(err) {
	return err && typeof err === "object" && "code" in err ? String(err.code) : null;
}
function createEmptyRecoverySummary() {
	return {
		recovered: 0,
		failed: 0,
		skippedMaxRetries: 0,
		deferredBackoff: 0
	};
}
function claimRecoveryEntry(entryId) {
	if (entriesInProgress.has(entryId)) return false;
	entriesInProgress.add(entryId);
	return true;
}
function releaseRecoveryEntry(entryId) {
	entriesInProgress.delete(entryId);
}
async function withActiveDeliveryClaim(entryId, fn) {
	if (!claimRecoveryEntry(entryId)) return { status: "claimed-by-other-owner" };
	try {
		return {
			status: "claimed",
			value: await fn()
		};
	} finally {
		releaseRecoveryEntry(entryId);
	}
}
function buildRecoveryDeliverParams(entry, cfg) {
	return {
		cfg,
		channel: entry.channel,
		to: entry.to,
		accountId: entry.accountId,
		payloads: entry.payloads,
		threadId: entry.threadId,
		replyToId: entry.replyToId,
		replyToMode: entry.replyToMode,
		formatting: entry.formatting,
		bestEffort: entry.bestEffort,
		gifPlayback: entry.gifPlayback,
		forceDocument: entry.forceDocument,
		silent: entry.silent,
		mirror: entry.mirror,
		session: entry.session,
		gatewayClientScopes: entry.gatewayClientScopes,
		skipQueue: true
	};
}
async function moveEntryToFailedWithLogging(entryId, log, stateDir) {
	try {
		await moveToFailed(entryId, stateDir);
	} catch (err) {
		log.error(`Failed to move entry ${entryId} to failed/: ${String(err)}`);
	}
}
async function deferRemainingEntriesForBudget(entries, stateDir) {
	await Promise.allSettled(entries.map((entry) => failDelivery(entry.id, "recovery time budget exceeded", stateDir)));
}
/** Compute the backoff delay in ms for a given retry count. */
function computeBackoffMs(retryCount) {
	if (retryCount <= 0) return 0;
	return BACKOFF_MS[Math.min(retryCount - 1, BACKOFF_MS.length - 1)] ?? BACKOFF_MS.at(-1) ?? 0;
}
function isEntryEligibleForRecoveryRetry(entry, now) {
	const backoff = computeBackoffMs(entry.retryCount + 1);
	if (backoff <= 0) return { eligible: true };
	if (entry.retryCount === 0 && entry.lastAttemptAt === void 0) return { eligible: true };
	const nextEligibleAt = (typeof entry.lastAttemptAt === "number" && Number.isFinite(entry.lastAttemptAt) && entry.lastAttemptAt > 0 ? entry.lastAttemptAt ?? entry.enqueuedAt : entry.enqueuedAt) + backoff;
	if (now >= nextEligibleAt) return { eligible: true };
	return {
		eligible: false,
		remainingBackoffMs: nextEligibleAt - now
	};
}
function isPermanentDeliveryError(error) {
	return PERMANENT_ERROR_PATTERNS.some((re) => re.test(error));
}
async function drainQueuedEntry(opts) {
	const { entry } = opts;
	try {
		await opts.deliver(buildRecoveryDeliverParams(entry, opts.cfg));
		await ackDelivery(entry.id, opts.stateDir);
		opts.onRecovered?.(entry);
		return "recovered";
	} catch (err) {
		const errMsg = formatErrorMessage(err);
		opts.onFailed?.(entry, errMsg);
		if (isPermanentDeliveryError(errMsg)) try {
			await moveToFailed(entry.id, opts.stateDir);
			return "moved-to-failed";
		} catch (moveErr) {
			if (getErrnoCode(moveErr) === "ENOENT") return "already-gone";
		}
		else try {
			await failDelivery(entry.id, errMsg, opts.stateDir);
			return "failed";
		} catch (failErr) {
			if (getErrnoCode(failErr) === "ENOENT") return "already-gone";
		}
		return "failed";
	}
}
async function drainPendingDeliveries(opts) {
	if (drainInProgress.get(opts.drainKey)) {
		opts.log.info(`${opts.logLabel}: already in progress for ${opts.drainKey}, skipping`);
		return;
	}
	drainInProgress.set(opts.drainKey, true);
	try {
		const now = Date.now();
		const deliver = opts.deliver;
		const matchingEntries = (await loadPendingDeliveries(opts.stateDir)).filter((entry) => opts.selectEntry(entry, now).match).toSorted((a, b) => a.enqueuedAt - b.enqueuedAt);
		if (matchingEntries.length === 0) return;
		opts.log.info(`${opts.logLabel}: ${matchingEntries.length} pending message(s) matched ${opts.drainKey}`);
		for (const entry of matchingEntries) {
			if (!claimRecoveryEntry(entry.id)) {
				opts.log.info(`${opts.logLabel}: entry ${entry.id} is already being recovered`);
				continue;
			}
			try {
				const currentEntry = await loadPendingDelivery(entry.id, opts.stateDir);
				if (!currentEntry) {
					opts.log.info(`${opts.logLabel}: entry ${entry.id} already gone, skipping`);
					continue;
				}
				const currentDecision = opts.selectEntry(currentEntry, Date.now());
				if (!currentDecision.match) {
					opts.log.info(`${opts.logLabel}: entry ${currentEntry.id} no longer matches, skipping`);
					continue;
				}
				if (currentEntry.retryCount >= 5) {
					try {
						await moveToFailed(currentEntry.id, opts.stateDir);
					} catch (err) {
						if (getErrnoCode(err) === "ENOENT") {
							opts.log.info(`${opts.logLabel}: entry ${currentEntry.id} already gone, skipping`);
							continue;
						}
						throw err;
					}
					opts.log.warn(`${opts.logLabel}: entry ${currentEntry.id} exceeded max retries and was moved to failed/`);
					continue;
				}
				if (!currentDecision.bypassBackoff) {
					const retryEligibility = isEntryEligibleForRecoveryRetry(currentEntry, Date.now());
					if (!retryEligibility.eligible) {
						opts.log.info(`${opts.logLabel}: entry ${currentEntry.id} not ready for retry yet — backoff ${retryEligibility.remainingBackoffMs}ms remaining`);
						continue;
					}
				}
				if (await drainQueuedEntry({
					entry: currentEntry,
					cfg: opts.cfg,
					deliver,
					stateDir: opts.stateDir,
					onFailed: (failedEntry, errMsg) => {
						if (isPermanentDeliveryError(errMsg)) {
							opts.log.warn(`${opts.logLabel}: entry ${failedEntry.id} hit permanent error — moving to failed/: ${errMsg}`);
							return;
						}
						opts.log.warn(`${opts.logLabel}: retry failed for entry ${failedEntry.id}: ${errMsg}`);
					}
				}) === "recovered") opts.log.info(`${opts.logLabel}: drained delivery ${currentEntry.id} on ${currentEntry.channel}`);
			} finally {
				releaseRecoveryEntry(entry.id);
			}
		}
	} finally {
		drainInProgress.delete(opts.drainKey);
	}
}
/**
* On gateway startup, scan the delivery queue and retry any pending entries.
* Uses exponential backoff and moves entries that exceed MAX_RETRIES to failed/.
*/
async function recoverPendingDeliveries(opts) {
	const pending = await loadPendingDeliveries(opts.stateDir);
	if (pending.length === 0) return createEmptyRecoverySummary();
	pending.sort((a, b) => a.enqueuedAt - b.enqueuedAt);
	opts.log.info(`Found ${pending.length} pending delivery entries — starting recovery`);
	const deadline = Date.now() + (opts.maxRecoveryMs ?? 6e4);
	const summary = createEmptyRecoverySummary();
	for (let i = 0; i < pending.length; i++) {
		const entry = pending[i];
		if (Date.now() >= deadline) {
			opts.log.warn(`Recovery time budget exceeded — remaining entries deferred to next startup`);
			await deferRemainingEntriesForBudget(pending.slice(i), opts.stateDir);
			break;
		}
		if (!claimRecoveryEntry(entry.id)) {
			opts.log.info(`Recovery skipped for delivery ${entry.id}: already being processed`);
			continue;
		}
		try {
			const currentEntry = await loadPendingDelivery(entry.id, opts.stateDir);
			if (!currentEntry) {
				opts.log.info(`Recovery skipped for delivery ${entry.id}: already gone`);
				continue;
			}
			if (currentEntry.retryCount >= 5) {
				opts.log.warn(`Delivery ${currentEntry.id} exceeded max retries (${currentEntry.retryCount}/5) — moving to failed/`);
				await moveEntryToFailedWithLogging(currentEntry.id, opts.log, opts.stateDir);
				summary.skippedMaxRetries += 1;
				continue;
			}
			const currentRetryEligibility = isEntryEligibleForRecoveryRetry(currentEntry, Date.now());
			if (!currentRetryEligibility.eligible) {
				summary.deferredBackoff += 1;
				opts.log.info(`Delivery ${currentEntry.id} not ready for retry yet — backoff ${currentRetryEligibility.remainingBackoffMs}ms remaining`);
				continue;
			}
			if (await drainQueuedEntry({
				entry: currentEntry,
				cfg: opts.cfg,
				deliver: opts.deliver,
				stateDir: opts.stateDir,
				onRecovered: (recoveredEntry) => {
					summary.recovered += 1;
					opts.log.info(`Recovered delivery ${recoveredEntry.id} on ${recoveredEntry.channel}`);
				},
				onFailed: (failedEntry, errMsg) => {
					summary.failed += 1;
					if (isPermanentDeliveryError(errMsg)) {
						opts.log.warn(`Delivery ${failedEntry.id} hit permanent error — moving to failed/: ${errMsg}`);
						return;
					}
					opts.log.warn(`Retry failed for delivery ${failedEntry.id}: ${errMsg}`);
				}
			}) === "moved-to-failed") continue;
		} finally {
			releaseRecoveryEntry(entry.id);
		}
	}
	opts.log.info(`Delivery recovery complete: ${summary.recovered} recovered, ${summary.failed} failed, ${summary.skippedMaxRetries} skipped (max retries), ${summary.deferredBackoff} deferred (backoff)`);
	return summary;
}
//#endregion
export { recoverPendingDeliveries as a, enqueueDelivery as c, loadPendingDeliveries as d, loadPendingDelivery as f, isPermanentDeliveryError as i, ensureQueueDir as l, drainPendingDeliveries as n, withActiveDeliveryClaim as o, moveToFailed as p, isEntryEligibleForRecoveryRetry as r, ackDelivery as s, computeBackoffMs as t, failDelivery as u };
