import { y as resolveStateDir } from "./paths-Cw7f9XhU.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { t as sameFileIdentity } from "./file-identity-BKNyWMFA.js";
import { t as stringifyJsonDocument } from "./json-stringify-DYDqVIo7.js";
import { n as assertSafePathSegment } from "./safe-path-segment-CvOPESFB.js";
import { r as replaceFileAtomic } from "./replace-file-C7_Inj8B.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { a as generateSecureUuid } from "./secure-random-BxnbXS5x.js";
import { n as resolveOutboundChannelMessageAdapter } from "./channel-resolution-Ecs0HEdK.js";
import fs from "node:fs";
import path from "node:path";
function getErrnoCode$1(error) {
	return error && typeof error === "object" && "code" in error ? String(error.code) : null;
}
function assertSafeQueueEntryId(id) {
	assertSafePathSegment(id, { label: "queue entry id" });
}
async function unlinkBestEffort(filePath) {
	await fs.promises.unlink(filePath).catch(() => void 0);
}
async function jsonDurableQueueEntryExists(filePath) {
	try {
		return (await fs.promises.lstat(filePath)).isFile();
	} catch (error) {
		if (getErrnoCode$1(error) === "ENOENT") return false;
		throw error;
	}
}
async function unlinkStaleTmpBestEffort(filePath, now, maxAgeMs) {
	try {
		const stat = await fs.promises.stat(filePath);
		if (stat.isFile() && now - stat.mtimeMs >= maxAgeMs) await unlinkBestEffort(filePath);
	} catch (error) {
		if (getErrnoCode$1(error) !== "ENOENT") throw error;
	}
}
function resolveJsonDurableQueueEntryPaths(queueDir, id) {
	assertSafeQueueEntryId(id);
	return {
		jsonPath: path.join(queueDir, `${id}.json`),
		deliveredPath: path.join(queueDir, `${id}.delivered`)
	};
}
async function ensureJsonDurableQueueDirs(params) {
	const roots = await queueValidationRoots(params.queueDir, params.failedDir);
	await ensureJsonDurableQueueDir(params.queueDir, roots.queueRoot);
	await ensureJsonDurableQueueDir(params.failedDir, roots.failedRoot);
}
async function ensureJsonDurableQueueDir(dir, validationRoot) {
	const root = validationRoot ? validationRoot : queueValidationRoot(dir);
	await assertNoSymlinkDirectorySegments(root, dir, true);
	await fs.promises.mkdir(dir, {
		recursive: true,
		mode: 448
	});
	await assertNoSymlinkDirectorySegments(root, dir, false);
	await chmodQueueDirectory(dir);
}
async function assertJsonDurableQueueDir(dir, validationRoot) {
	await assertNoSymlinkDirectorySegments(validationRoot ? validationRoot : queueValidationRoot(dir), dir, false);
}
function commonPathAncestor(paths) {
	const resolved = paths.map((entry) => path.resolve(entry));
	const root = path.parse(resolved[0] ?? process.cwd()).root;
	const parts = resolved.map((entry) => path.relative(root, entry).split(path.sep));
	const common = [];
	for (let index = 0; parts.every((part) => index < part.length); index++) {
		const segment = parts[0]?.[index];
		if (!segment || !parts.every((part) => part[index] === segment)) break;
		common.push(segment);
	}
	return path.join(root, ...common);
}
function samePathRoot(paths) {
	const roots = paths.map((entry) => path.parse(path.resolve(entry)).root);
	const first = process.platform === "win32" ? roots[0]?.toLowerCase() : roots[0];
	return roots.every((root) => (process.platform === "win32" ? root.toLowerCase() : root) === first);
}
async function queueValidationRoots(queueDir, failedDir) {
	if (samePathRoot([queueDir, failedDir])) {
		const root = queueValidationRoot(commonPathAncestor([queueDir, failedDir]));
		return {
			failedRoot: root,
			queueRoot: root
		};
	}
	return {
		failedRoot: queueValidationRoot(failedDir),
		queueRoot: queueValidationRoot(queueDir)
	};
}
function queueValidationRoot(dir) {
	return {
		path: path.parse(path.resolve(dir)).root,
		allowSymlinkBase: process.platform === "darwin"
	};
}
async function isDarwinSystemAlias(dir, stat) {
	if (process.platform !== "darwin" || !stat.isSymbolicLink()) return false;
	const resolved = path.resolve(dir);
	if (resolved !== "/tmp" && resolved !== "/var") return false;
	return await fs.promises.realpath(resolved).then((realPath) => realPath === `/private${resolved}`, () => false);
}
async function assertNoSymlinkDirectorySegments(validationRoot, dir, allowMissing) {
	let base = path.resolve(validationRoot.path);
	let target = path.resolve(dir);
	let current = base;
	let baseStat = await fs.promises.lstat(base);
	if (baseStat.isSymbolicLink() && validationRoot.allowSymlinkBase) {
		const relative = path.relative(base, target);
		if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`durable queue path is not a directory: ${dir}`);
		base = await fs.promises.realpath(base);
		target = path.join(base, ...relative.split(path.sep).filter(Boolean));
		current = base;
		baseStat = await fs.promises.lstat(base);
	}
	if (baseStat.isSymbolicLink() || !baseStat.isDirectory()) throw new Error(`durable queue path is not a directory: ${dir}`);
	const segments = path.relative(base, target).split(path.sep).filter(Boolean);
	for (let index = 0; index < segments.length; index++) {
		const segment = segments[index];
		if (segment === void 0) continue;
		current = path.join(current, segment);
		let stat;
		try {
			stat = await fs.promises.lstat(current);
		} catch (error) {
			if (allowMissing && error.code === "ENOENT") return;
			throw error;
		}
		if (stat.isSymbolicLink() || !stat.isDirectory()) {
			if (stat.isSymbolicLink() && validationRoot.allowSymlinkBase) {
				if (await isDarwinSystemAlias(current, stat)) {
					current = await fs.promises.realpath(current);
					continue;
				}
			}
			throw new Error(`durable queue path is not a directory: ${dir}`);
		}
	}
}
async function chmodQueueDirectory(dir) {
	const noFollow = typeof fs.constants.O_NOFOLLOW === "number" && process.platform !== "win32" ? fs.constants.O_NOFOLLOW : 0;
	const directoryFlag = typeof fs.constants.O_DIRECTORY === "number" && process.platform !== "win32" ? fs.constants.O_DIRECTORY : 0;
	if (noFollow || directoryFlag) {
		let handle;
		try {
			handle = await fs.promises.open(dir, fs.constants.O_RDONLY | noFollow | directoryFlag);
			if (!(await handle.stat()).isDirectory()) throw new Error(`durable queue path is not a directory: ${dir}`);
			try {
				await handle.chmod(448);
			} catch {}
			return;
		} finally {
			try {
				await handle?.close();
			} catch {}
		}
	}
	const stat = await fs.promises.lstat(dir);
	if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`durable queue path is not a directory: ${dir}`);
	try {
		await fs.promises.chmod(dir, 448);
	} catch {}
}
async function writeJsonDurableQueueEntry(params) {
	await replaceFileAtomic({
		filePath: params.filePath,
		content: stringifyJsonDocument(params.entry, null, 2),
		mode: 384,
		tempPrefix: params.tempPrefix
	});
}
async function readBoundedUtf8File(params) {
	const initialStat = await fs.promises.lstat(params.filePath);
	if (initialStat.isSymbolicLink() || !initialStat.isFile()) throw new Error("queue entry is not a regular file");
	if (initialStat.nlink > 1) throw new Error("queue entry hardlinks are not allowed");
	if (initialStat.size > params.maxBytes) throw new Error(`queue entry exceeds ${params.maxBytes} bytes`);
	const noFollow = typeof fs.constants.O_NOFOLLOW === "number" && process.platform !== "win32" ? fs.constants.O_NOFOLLOW : 0;
	const handle = await fs.promises.open(params.filePath, fs.constants.O_RDONLY | noFollow);
	try {
		const openedStat = await handle.stat();
		const pathStat = await fs.promises.lstat(params.filePath);
		if (!openedStat.isFile() || pathStat.isSymbolicLink() || !pathStat.isFile() || openedStat.nlink > 1 || pathStat.nlink > 1 || !sameFileIdentity(initialStat, openedStat) || !sameFileIdentity(pathStat, openedStat)) throw new Error("queue entry changed during read");
		const chunks = [];
		const scratch = Buffer.allocUnsafe(Math.min(64 * 1024, params.maxBytes + 1));
		let total = 0;
		while (true) {
			const { bytesRead } = await handle.read(scratch, 0, scratch.length, null);
			if (bytesRead === 0) return Buffer.concat(chunks, total).toString("utf8");
			total += bytesRead;
			if (total > params.maxBytes) throw new Error(`queue entry exceeds ${params.maxBytes} bytes`);
			chunks.push(Buffer.from(scratch.subarray(0, bytesRead)));
		}
	} finally {
		await handle.close();
	}
}
async function readJsonDurableQueueEntry(filePath, options = {}) {
	return JSON.parse(await readBoundedUtf8File({
		filePath,
		maxBytes: options.maxBytes ?? 16777216
	}));
}
async function ackJsonDurableQueueEntry(paths) {
	try {
		await fs.promises.rename(paths.jsonPath, paths.deliveredPath);
	} catch (error) {
		if (getErrnoCode$1(error) === "ENOENT") {
			await unlinkBestEffort(paths.deliveredPath);
			return;
		}
		throw error;
	}
	await unlinkBestEffort(paths.deliveredPath);
}
async function loadJsonDurableQueueEntry(params) {
	try {
		if (!(await fs.promises.lstat(params.paths.jsonPath)).isFile()) return null;
		const raw = await readJsonDurableQueueEntry(params.paths.jsonPath, { maxBytes: params.maxBytes });
		const result = params.read ? await params.read(raw, params.paths.jsonPath) : { entry: raw };
		if (result.migrated) await writeJsonDurableQueueEntry({
			filePath: params.paths.jsonPath,
			entry: result.entry,
			tempPrefix: params.tempPrefix
		});
		return result.entry;
	} catch (error) {
		if (getErrnoCode$1(error) === "ENOENT") return null;
		throw error;
	}
}
async function loadPendingJsonDurableQueueEntries(options) {
	let files;
	try {
		files = await fs.promises.readdir(options.queueDir);
	} catch (error) {
		if (getErrnoCode$1(error) === "ENOENT") return [];
		throw error;
	}
	const now = Date.now();
	for (const file of files) if (file.endsWith(".delivered")) await unlinkBestEffort(path.join(options.queueDir, file));
	else if (options.cleanupTmpMaxAgeMs !== void 0 && file.endsWith(".tmp")) await unlinkStaleTmpBestEffort(path.join(options.queueDir, file), now, options.cleanupTmpMaxAgeMs);
	const entries = [];
	for (const file of files) {
		if (!file.endsWith(".json")) continue;
		const filePath = path.join(options.queueDir, file);
		try {
			if (!(await fs.promises.lstat(filePath)).isFile()) continue;
			const raw = await readJsonDurableQueueEntry(filePath, { maxBytes: options.maxBytes });
			const result = options.read ? await options.read(raw, filePath) : { entry: raw };
			if (result.migrated) await writeJsonDurableQueueEntry({
				filePath,
				entry: result.entry,
				tempPrefix: options.tempPrefix
			});
			entries.push(result.entry);
		} catch {
			continue;
		}
	}
	return entries;
}
async function moveJsonDurableQueueEntryToFailed(params) {
	assertSafeQueueEntryId(params.id);
	const roots = await queueValidationRoots(params.queueDir, params.failedDir);
	await assertJsonDurableQueueDir(params.queueDir, roots.queueRoot);
	await ensureJsonDurableQueueDir(params.failedDir, roots.failedRoot);
	await fs.promises.rename(path.join(params.queueDir, `${params.id}.json`), path.join(params.failedDir, `${params.id}.json`));
}
//#endregion
//#region src/infra/outbound/delivery-commit-hooks.ts
const log = createSubsystemLogger("outbound/deliver");
const outboundDeliveryCommitHooks = /* @__PURE__ */ new WeakMap();
function attachOutboundDeliveryCommitHook(result, hook) {
	if (!hook) return result;
	const hooks = outboundDeliveryCommitHooks.get(result) ?? [];
	hooks.push(hook);
	outboundDeliveryCommitHooks.set(result, hooks);
	return result;
}
async function runOutboundDeliveryCommitHooks(results) {
	for (const result of results) for (const hook of outboundDeliveryCommitHooks.get(result) ?? []) try {
		await hook();
	} catch (err) {
		log.warn("Plugin message adapter after-commit hook failed.", {
			channel: result.channel,
			messageId: result.messageId,
			error: formatErrorMessage(err)
		});
	}
}
function isOutboundDeliveryResultArray(value) {
	return Array.isArray(value);
}
//#endregion
//#region src/infra/outbound/delivery-queue-storage.ts
const QUEUE_DIRNAME = "delivery-queue";
const FAILED_DIRNAME = "failed";
const QUEUE_TEMP_PREFIX = ".delivery-queue";
function resolveQueueDir(stateDir) {
	const base = stateDir ?? resolveStateDir();
	return path.join(base, QUEUE_DIRNAME);
}
function resolveFailedDir(stateDir) {
	return path.join(resolveQueueDir(stateDir), FAILED_DIRNAME);
}
function resolveQueueEntryPaths(id, stateDir) {
	return resolveJsonDurableQueueEntryPaths(resolveQueueDir(stateDir), id);
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
	await ensureJsonDurableQueueDirs({
		queueDir,
		failedDir: resolveFailedDir(stateDir)
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
		renderedBatchPlan: params.renderedBatchPlan,
		threadId: params.threadId,
		replyToId: params.replyToId,
		replyToMode: params.replyToMode,
		formatting: params.formatting,
		identity: params.identity,
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
	await ackJsonDurableQueueEntry(resolveQueueEntryPaths(id, stateDir));
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
async function markDeliveryPlatformSendAttemptStarted(id, stateDir) {
	const filePath = path.join(resolveQueueDir(stateDir), `${id}.json`);
	const entry = await readQueueEntry(filePath);
	entry.platformSendStartedAt = entry.platformSendStartedAt ?? Date.now();
	entry.recoveryState = "send_attempt_started";
	await writeQueueEntry(filePath, entry);
}
async function markDeliveryPlatformOutcomeUnknown(id, stateDir) {
	const filePath = path.join(resolveQueueDir(stateDir), `${id}.json`);
	const entry = await readQueueEntry(filePath);
	entry.platformSendStartedAt = entry.platformSendStartedAt ?? Date.now();
	entry.recoveryState = "unknown_after_send";
	await writeQueueEntry(filePath, entry);
}
/** Load a single pending delivery entry by ID from the queue directory. */
async function loadPendingDelivery(id, stateDir) {
	return await loadJsonDurableQueueEntry({
		paths: resolveQueueEntryPaths(id, stateDir),
		tempPrefix: QUEUE_TEMP_PREFIX,
		read: async (entry) => normalizeLegacyQueuedDeliveryEntry(entry)
	});
}
/** Load all pending delivery entries from the queue directory. */
async function loadPendingDeliveries(stateDir) {
	return await loadPendingJsonDurableQueueEntries({
		queueDir: resolveQueueDir(stateDir),
		tempPrefix: QUEUE_TEMP_PREFIX,
		read: async (entry) => normalizeLegacyQueuedDeliveryEntry(entry)
	});
}
/** Move a queue entry to the failed/ subdirectory. */
async function moveToFailed(id, stateDir) {
	await moveJsonDurableQueueEntryToFailed({
		queueDir: resolveQueueDir(stateDir),
		failedDir: resolveFailedDir(stateDir),
		id
	});
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
function buildRecoveryDeliverParams(entry, cfg, stateDir) {
	return {
		cfg,
		channel: entry.channel,
		to: entry.to,
		accountId: entry.accountId,
		payloads: entry.payloads,
		renderedBatchPlan: entry.renderedBatchPlan,
		threadId: entry.threadId,
		replyToId: entry.replyToId,
		replyToMode: entry.replyToMode,
		formatting: entry.formatting,
		identity: entry.identity,
		bestEffort: entry.bestEffort,
		gifPlayback: entry.gifPlayback,
		forceDocument: entry.forceDocument,
		silent: entry.silent,
		mirror: entry.mirror,
		session: entry.session,
		gatewayClientScopes: entry.gatewayClientScopes,
		deliveryQueueId: entry.id,
		deliveryQueueStateDir: stateDir,
		skipQueue: true,
		deferCommitHooks: true
	};
}
async function reconcileUnknownQueuedDelivery(opts) {
	const adapter = resolveOutboundChannelMessageAdapter({
		channel: opts.entry.channel,
		cfg: opts.cfg,
		allowBootstrap: true
	});
	if (adapter?.durableFinal?.capabilities?.reconcileUnknownSend !== true) return null;
	const reconcileUnknownSend = adapter?.durableFinal?.reconcileUnknownSend;
	if (!reconcileUnknownSend) return null;
	const { entry } = opts;
	try {
		return await reconcileUnknownSend({
			cfg: opts.cfg,
			queueId: entry.id,
			channel: entry.channel,
			to: entry.to,
			...entry.accountId !== void 0 ? { accountId: entry.accountId } : {},
			enqueuedAt: entry.enqueuedAt,
			retryCount: entry.retryCount,
			...entry.platformSendStartedAt !== void 0 ? { platformSendStartedAt: entry.platformSendStartedAt } : {},
			payloads: entry.payloads,
			...entry.renderedBatchPlan ? { renderedBatchPlan: entry.renderedBatchPlan } : {},
			...entry.replyToId !== void 0 ? { replyToId: entry.replyToId } : {},
			...entry.replyToMode !== void 0 ? { replyToMode: entry.replyToMode } : {},
			...entry.threadId !== void 0 ? { threadId: entry.threadId } : {},
			...entry.silent !== void 0 ? { silent: entry.silent } : {}
		});
	} catch (err) {
		const error = formatErrorMessage(err);
		opts.log.warn(`Delivery entry ${opts.entry.id} unknown-send reconciliation failed: ${error}`);
		return {
			status: "unresolved",
			error,
			retryable: true
		};
	}
}
function buildReconciledSentResult(entry, reconciliation) {
	return {
		channel: entry.channel,
		messageId: reconciliation.messageId ?? reconciliation.receipt.primaryPlatformMessageId ?? reconciliation.receipt.platformMessageIds[0] ?? "",
		receipt: reconciliation.receipt
	};
}
function buildReconciledCommitContext(params) {
	const payload = params.entry.payloads[0] ?? {};
	const result = {
		messageId: params.result.messageId,
		receipt: params.result.receipt ?? {
			platformMessageIds: [params.result.messageId].filter(Boolean),
			parts: [],
			sentAt: Date.now()
		}
	};
	const base = {
		cfg: params.cfg,
		to: params.entry.to,
		accountId: params.entry.accountId,
		replyToId: params.entry.replyToId,
		replyToMode: params.entry.replyToMode,
		threadId: params.entry.threadId,
		silent: params.entry.silent,
		result
	};
	if (payload.presentation !== void 0 || payload.delivery !== void 0 || payload.interactive !== void 0 || payload.channelData !== void 0 && Object.keys(payload.channelData).length > 0) return {
		...base,
		kind: "payload",
		text: payload.text ?? "",
		mediaUrl: payload.mediaUrl,
		payload
	};
	const mediaUrl = payload.mediaUrl ?? payload.mediaUrls?.find((url) => url);
	if (mediaUrl) return {
		...base,
		kind: "media",
		text: payload.text ?? "",
		mediaUrl,
		audioAsVoice: payload.audioAsVoice,
		gifPlayback: params.entry.gifPlayback,
		forceDocument: params.entry.forceDocument
	};
	return {
		...base,
		kind: "text",
		text: payload.text ?? ""
	};
}
async function runReconciledSentCommitHooks(params) {
	const afterCommit = resolveOutboundChannelMessageAdapter({
		channel: params.entry.channel,
		cfg: params.cfg,
		allowBootstrap: true
	})?.send?.lifecycle?.afterCommit;
	if (!afterCommit) return;
	const result = buildReconciledSentResult(params.entry, params.reconciliation);
	try {
		await afterCommit(buildReconciledCommitContext({
			entry: params.entry,
			cfg: params.cfg,
			result
		}));
	} catch (err) {
		params.log.warn(`Delivery entry ${params.entry.id} reconciled sent afterCommit hook failed: ${formatErrorMessage(err)}`);
	}
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
	if (entry.recoveryState === "send_attempt_started" || entry.recoveryState === "unknown_after_send") {
		const reconciliation = await reconcileUnknownQueuedDelivery({
			entry,
			cfg: opts.cfg,
			log: opts.log
		});
		if (reconciliation?.status === "sent") try {
			await ackDelivery(entry.id, opts.stateDir);
			await runReconciledSentCommitHooks({
				entry,
				cfg: opts.cfg,
				reconciliation,
				log: opts.log
			});
			opts.onRecovered?.(entry);
			opts.log.info(`Delivery entry ${entry.id} reconciled unknown_after_send as already sent`);
			return "recovered";
		} catch (ackErr) {
			if (getErrnoCode(ackErr) === "ENOENT") return "already-gone";
			const errMsg = `failed to ack reconciled sent delivery: ${formatErrorMessage(ackErr)}`;
			opts.log.warn(`Delivery entry ${entry.id} ${errMsg}`);
			opts.onFailed?.(entry, errMsg);
			try {
				await failDelivery(entry.id, errMsg, opts.stateDir);
				return "failed";
			} catch (failErr) {
				if (getErrnoCode(failErr) === "ENOENT") return "already-gone";
			}
			return "failed";
		}
		if (reconciliation?.status === "not_sent") opts.log.info(`Delivery entry ${entry.id} reconciled ${entry.recoveryState} as not sent; replaying`);
		else {
			const errMsg = reconciliation?.status === "unresolved" && reconciliation.error ? `delivery state is ${entry.recoveryState} and reconciliation is unresolved: ${reconciliation.error}` : `delivery state is ${entry.recoveryState}; refusing blind replay without adapter reconciliation`;
			opts.log.warn(`Delivery entry ${entry.id} ${errMsg}`);
			opts.onFailed?.(entry, errMsg);
			if (reconciliation?.status === "unresolved" && reconciliation.retryable === true) {
				try {
					await failDelivery(entry.id, errMsg, opts.stateDir);
					return "failed";
				} catch (failErr) {
					if (getErrnoCode(failErr) === "ENOENT") return "already-gone";
				}
				return "failed";
			}
			try {
				await moveToFailed(entry.id, opts.stateDir);
				return "moved-to-failed";
			} catch (moveErr) {
				if (getErrnoCode(moveErr) === "ENOENT") return "already-gone";
			}
			return "failed";
		}
	}
	try {
		const result = await opts.deliver(buildRecoveryDeliverParams(entry, opts.cfg, opts.stateDir));
		await ackDelivery(entry.id, opts.stateDir);
		if (isOutboundDeliveryResultArray(result)) await runOutboundDeliveryCommitHooks(result);
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
					log: opts.log,
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
				log: opts.log,
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
export { moveJsonDurableQueueEntryToFailed as C, writeJsonDurableQueueEntry as E, loadPendingJsonDurableQueueEntries as S, resolveJsonDurableQueueEntryPaths as T, runOutboundDeliveryCommitHooks as _, recoverPendingDeliveries as a, jsonDurableQueueEntryExists as b, enqueueDelivery as c, loadPendingDeliveries as d, loadPendingDelivery as f, attachOutboundDeliveryCommitHook as g, moveToFailed as h, isPermanentDeliveryError as i, ensureQueueDir as l, markDeliveryPlatformSendAttemptStarted as m, drainPendingDeliveries as n, withActiveDeliveryClaim as o, markDeliveryPlatformOutcomeUnknown as p, isEntryEligibleForRecoveryRetry as r, ackDelivery as s, computeBackoffMs as t, failDelivery as u, ackJsonDurableQueueEntry as v, readJsonDurableQueueEntry as w, loadJsonDurableQueueEntry as x, ensureJsonDurableQueueDirs as y };
