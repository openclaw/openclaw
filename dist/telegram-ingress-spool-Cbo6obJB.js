import { v as resolveStateDir } from "./paths-Cnwfh6dH.js";
import { n as readJsonFileWithFallback } from "./json-store-BUuXUY1y.js";
import "./state-paths-DTRyq4vN.js";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { randomUUID } from "node:crypto";
//#region extensions/telegram/src/telegram-ingress-spool.ts
const SPOOL_VERSION = 1;
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
function parseSpooledUpdate(value, filePath) {
	if (!value || typeof value !== "object") return null;
	const payload = value;
	if (payload.version !== SPOOL_VERSION || !isValidUpdateId(payload.updateId)) return null;
	return {
		updateId: payload.updateId,
		path: filePath,
		update: payload.update,
		receivedAt: typeof payload.receivedAt === "number" ? payload.receivedAt : 0
	};
}
async function writeTelegramSpooledUpdate(params) {
	const updateId = resolveTelegramUpdateId(params.update);
	if (updateId === null) throw new Error("Telegram update missing numeric update_id.");
	await fs.mkdir(params.spoolDir, { recursive: true });
	const targetPath = path.join(params.spoolDir, spoolFileName(updateId));
	const tempPath = path.join(params.spoolDir, `${spoolFileName(updateId)}.${randomUUID()}.tmp`);
	const payload = {
		version: SPOOL_VERSION,
		updateId,
		receivedAt: params.now ?? Date.now(),
		update: params.update
	};
	await fs.writeFile(tempPath, `${JSON.stringify(payload)}\n`, { mode: 384 });
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
	const files = entries.filter((entry) => entry.endsWith(".json")).toSorted().slice(0, Math.max(1, params.limit ?? 100));
	const updates = [];
	for (const file of files) {
		const filePath = path.join(params.spoolDir, file);
		const { value } = await readJsonFileWithFallback(filePath, null);
		const parsed = parseSpooledUpdate(value, filePath);
		if (parsed) updates.push(parsed);
	}
	return updates;
}
async function deleteTelegramSpooledUpdate(update) {
	try {
		await fs.unlink(update.path);
	} catch (err) {
		if (err.code === "ENOENT") return;
		throw err;
	}
}
//#endregion
export { writeTelegramSpooledUpdate as i, listTelegramSpooledUpdates as n, resolveTelegramIngressSpoolDir as r, deleteTelegramSpooledUpdate as t };
