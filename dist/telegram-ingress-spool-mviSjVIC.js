import { y as resolveStateDir } from "./paths-Cw7f9XhU.js";
import { n as readJsonFileWithFallback } from "./json-store-ChgPP2Sf.js";
import "./state-paths-iYyQ0JoC.js";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { randomUUID } from "node:crypto";
//#region extensions/telegram/src/telegram-ingress-spool.ts
const SPOOL_VERSION = 1;
const TELEGRAM_SPOOLED_UPDATE_PROCESSING_STALE_MS = 360 * 60 * 1e3;
const TELEGRAM_SPOOLED_UPDATE_PROCESS_ID = `${process.pid}:${randomUUID()}`;
function normalizeAccountId(accountId) {
	const trimmed = accountId?.trim();
	if (!trimmed) return "default";
	return trimmed.replace(/[^a-z0-9._-]+/gi, "_");
}
function isValidUpdateId(value) {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function resolveTelegramIngressSpoolDir(params) {
	const stateDir = resolveStateDir(params.env, os.homedir);
	return path.join(stateDir, "telegram", `ingress-spool-${normalizeAccountId(params.accountId)}`);
}
function resolveTelegramUpdateId(update) {
	if (!update || typeof update !== "object") return null;
	const value = update.update_id;
	return isValidUpdateId(value) ? value : null;
}
function spoolFileName(updateId) {
	return `${String(updateId).padStart(16, "0")}.json`;
}
function processingFileName(updateId) {
	return `${spoolFileName(updateId)}.processing`;
}
function failedFileName(updateId) {
	return `${spoolFileName(updateId)}.failed`;
}
function isProcessingFileName(fileName) {
	return fileName.endsWith(".json.processing");
}
function pendingFileNameFromProcessing(fileName) {
	return fileName.slice(0, -11);
}
function processingPath(spoolDir, updateId) {
	return path.join(spoolDir, processingFileName(updateId));
}
function failedPath(spoolDir, updateId) {
	return path.join(spoolDir, failedFileName(updateId));
}
async function pathExists(filePath) {
	try {
		await fs.access(filePath);
		return true;
	} catch (err) {
		if (err.code === "ENOENT") return false;
		throw err;
	}
}
async function unlinkIfPresent(filePath) {
	try {
		await fs.unlink(filePath);
	} catch (err) {
		if (err.code === "ENOENT") return;
		throw err;
	}
}
function parseSpooledUpdate(value, filePath) {
	if (!value || typeof value !== "object") return null;
	const payload = value;
	if (payload.version !== SPOOL_VERSION || !isValidUpdateId(payload.updateId)) return null;
	const update = {
		updateId: payload.updateId,
		path: filePath,
		update: payload.update,
		receivedAt: typeof payload.receivedAt === "number" ? payload.receivedAt : 0
	};
	if (payload.claim && typeof payload.claim.processId === "string" && isValidUpdateId(payload.claim.processPid) && typeof payload.claim.claimedAt === "number") update.claim = payload.claim;
	return update;
}
function buildClaimedPayload(update) {
	return {
		version: SPOOL_VERSION,
		updateId: update.updateId,
		receivedAt: update.receivedAt,
		update: update.update,
		claim: {
			processId: TELEGRAM_SPOOLED_UPDATE_PROCESS_ID,
			processPid: process.pid,
			claimedAt: Date.now()
		}
	};
}
function processExists(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return err.code !== "ESRCH";
	}
}
function isFreshClaimOwner(claim) {
	return Date.now() - claim.claimedAt < TELEGRAM_SPOOLED_UPDATE_PROCESSING_STALE_MS;
}
function isTelegramSpooledUpdateClaimOwnedByOtherLiveProcess(claim) {
	return Boolean(claim.claim && claim.claim.processId !== TELEGRAM_SPOOLED_UPDATE_PROCESS_ID && isFreshClaimOwner(claim.claim) && processExists(claim.claim.processPid));
}
async function writeTelegramSpooledUpdate(params) {
	const updateId = resolveTelegramUpdateId(params.update);
	if (updateId === null) throw new Error("Telegram update missing numeric update_id.");
	await fs.mkdir(params.spoolDir, { recursive: true });
	const targetPath = path.join(params.spoolDir, spoolFileName(updateId));
	const claimedPath = processingPath(params.spoolDir, updateId);
	const tombstonePath = failedPath(params.spoolDir, updateId);
	if (await pathExists(claimedPath) || await pathExists(tombstonePath)) return updateId;
	const tempPath = path.join(params.spoolDir, `${spoolFileName(updateId)}.${randomUUID()}.tmp`);
	const payload = {
		version: SPOOL_VERSION,
		updateId,
		receivedAt: params.now ?? Date.now(),
		update: params.update
	};
	await fs.writeFile(tempPath, `${JSON.stringify(payload)}\n`, { mode: 384 });
	if (await pathExists(claimedPath) || await pathExists(tombstonePath)) {
		await unlinkIfPresent(tempPath);
		return updateId;
	}
	await fs.rename(tempPath, targetPath);
	return updateId;
}
async function listTelegramSpooledUpdates(params) {
	let entries;
	try {
		entries = await fs.readdir(params.spoolDir);
	} catch (err) {
		if (err.code === "ENOENT") return [];
		throw err;
	}
	const entrySet = new Set(entries);
	const files = entries.filter((entry) => entry.endsWith(".json") && !entrySet.has(`${entry}.failed`)).toSorted();
	const limitedFiles = params.limit === "all" ? files : files.slice(0, Math.max(1, params.limit ?? 100));
	const updates = [];
	for (const file of limitedFiles) {
		const filePath = path.join(params.spoolDir, file);
		const { value } = await readJsonFileWithFallback(filePath, null);
		const parsed = parseSpooledUpdate(value, filePath);
		if (parsed) updates.push(parsed);
	}
	return updates;
}
async function deleteTelegramSpooledUpdate(update) {
	await unlinkIfPresent(update.path);
	if ("pendingPath" in update && typeof update.pendingPath === "string") await unlinkIfPresent(update.pendingPath);
}
async function claimTelegramSpooledUpdate(update) {
	const claimedPath = processingPath(path.dirname(update.path), update.updateId);
	const holdPath = path.join(path.dirname(update.path), `${spoolFileName(update.updateId)}.${randomUUID()}.claim`);
	const tempPath = path.join(path.dirname(update.path), `${processingFileName(update.updateId)}.${randomUUID()}.tmp`);
	try {
		const claimedAt = /* @__PURE__ */ new Date();
		await fs.writeFile(tempPath, `${JSON.stringify(buildClaimedPayload(update))}\n`, { mode: 384 });
		await fs.link(update.path, holdPath);
		await fs.link(tempPath, claimedPath);
		await unlinkIfPresent(tempPath);
		await unlinkIfPresent(holdPath);
		await fs.utimes(claimedPath, claimedAt, claimedAt);
		await unlinkIfPresent(update.path);
	} catch (err) {
		const code = err.code;
		await unlinkIfPresent(tempPath);
		await unlinkIfPresent(holdPath);
		if (code === "ENOENT" || code === "EEXIST") return null;
		throw err;
	}
	return {
		...update,
		path: claimedPath,
		pendingPath: update.path
	};
}
async function releaseTelegramSpooledUpdateClaim(update) {
	try {
		await fs.rename(update.path, update.pendingPath);
	} catch (err) {
		const code = err.code;
		if (code === "ENOENT") return;
		if (code === "EEXIST") {
			await unlinkIfPresent(update.path);
			return;
		}
		throw err;
	}
}
async function failTelegramSpooledUpdateClaim(params) {
	const tombstonePath = failedPath(path.dirname(params.update.path), params.update.updateId);
	const tempPath = path.join(path.dirname(params.update.path), `${failedFileName(params.update.updateId)}.${randomUUID()}.tmp`);
	try {
		const { value } = await readJsonFileWithFallback(params.update.path, null);
		const parsed = parseSpooledUpdate(value, params.update.path);
		if (!parsed) return false;
		const payload = {
			version: SPOOL_VERSION,
			updateId: parsed.updateId,
			receivedAt: parsed.receivedAt,
			failure: {
				reason: params.reason,
				message: params.message,
				failedAt: params.now ?? Date.now()
			}
		};
		await fs.writeFile(tempPath, `${JSON.stringify(payload)}\n`, { mode: 384 });
		await fs.rename(tempPath, tombstonePath);
		await unlinkIfPresent(params.update.path);
		await unlinkIfPresent(params.update.pendingPath);
		return true;
	} catch (err) {
		await unlinkIfPresent(tempPath);
		if (err.code === "ENOENT") return false;
		throw err;
	}
}
async function listTelegramSpooledUpdateClaims(params) {
	let entries;
	try {
		entries = await fs.readdir(params.spoolDir);
	} catch (err) {
		if (err.code === "ENOENT") return [];
		throw err;
	}
	const claims = [];
	const entrySet = new Set(entries);
	for (const file of entries.filter(isProcessingFileName).toSorted()) {
		if (entrySet.has(`${pendingFileNameFromProcessing(file)}.failed`)) continue;
		const filePath = path.join(params.spoolDir, file);
		const { value } = await readJsonFileWithFallback(filePath, null);
		const parsed = parseSpooledUpdate(value, filePath);
		if (parsed) claims.push({
			...parsed,
			pendingPath: path.join(params.spoolDir, pendingFileNameFromProcessing(file))
		});
	}
	return claims;
}
async function recoverStaleTelegramSpooledUpdateClaims(params) {
	let entries;
	try {
		entries = await fs.readdir(params.spoolDir);
	} catch (err) {
		if (err.code === "ENOENT") return 0;
		throw err;
	}
	const staleMs = Math.max(0, Math.floor(params.staleMs ?? 216e5));
	const now = params.now ?? Date.now();
	let recovered = 0;
	const entrySet = new Set(entries);
	for (const entry of entries.filter(isProcessingFileName).toSorted()) {
		const claimedPath = path.join(params.spoolDir, entry);
		const pendingPath = path.join(params.spoolDir, pendingFileNameFromProcessing(entry));
		if (entrySet.has(`${pendingFileNameFromProcessing(entry)}.failed`)) {
			await unlinkIfPresent(claimedPath);
			await unlinkIfPresent(pendingPath);
			continue;
		}
		let stat;
		try {
			stat = await fs.stat(claimedPath);
		} catch (err) {
			if (err.code === "ENOENT") continue;
			throw err;
		}
		if (now - stat.mtimeMs < staleMs) continue;
		if (params.shouldRecover) {
			const { value } = await readJsonFileWithFallback(claimedPath, null);
			const parsed = parseSpooledUpdate(value, claimedPath);
			if (parsed && !await params.shouldRecover({
				...parsed,
				pendingPath
			})) continue;
		}
		if (await pathExists(pendingPath)) await unlinkIfPresent(claimedPath);
		else await fs.rename(claimedPath, pendingPath);
		recovered += 1;
	}
	return recovered;
}
//#endregion
export { listTelegramSpooledUpdateClaims as a, releaseTelegramSpooledUpdateClaim as c, isTelegramSpooledUpdateClaimOwnedByOtherLiveProcess as i, resolveTelegramIngressSpoolDir as l, deleteTelegramSpooledUpdate as n, listTelegramSpooledUpdates as o, failTelegramSpooledUpdateClaim as r, recoverStaleTelegramSpooledUpdateClaims as s, claimTelegramSpooledUpdate as t, writeTelegramSpooledUpdate as u };
