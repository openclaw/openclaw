import { i as init_paths, v as resolveStateDir } from "./paths-DqbqmTPe.js";
import { i as writeJsonAtomic, n as init_json_files } from "./json-files-Ci9Yrixm.js";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
//#region extensions/telegram/src/update-offset-store.ts
init_paths();
init_json_files();
const STORE_VERSION = 2;
function isValidUpdateId(value) {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function normalizeAccountId(accountId) {
	const trimmed = accountId?.trim();
	if (!trimmed) return "default";
	return trimmed.replace(/[^a-z0-9._-]+/gi, "_");
}
function resolveTelegramUpdateOffsetPath(accountId, env = process.env) {
	const stateDir = resolveStateDir(env, os.homedir);
	const normalized = normalizeAccountId(accountId);
	return path.join(stateDir, "telegram", `update-offset-${normalized}.json`);
}
function extractBotIdFromToken(token) {
	const trimmed = token?.trim();
	if (!trimmed) return null;
	const [rawBotId] = trimmed.split(":", 1);
	if (!rawBotId || !/^\d+$/.test(rawBotId)) return null;
	return rawBotId;
}
function safeParseState(raw) {
	try {
		const parsed = JSON.parse(raw);
		if (parsed?.version !== STORE_VERSION && parsed?.version !== 1) return null;
		if (parsed.lastUpdateId !== null && !isValidUpdateId(parsed.lastUpdateId)) return null;
		if (parsed.version === STORE_VERSION && parsed.botId !== null && typeof parsed.botId !== "string") return null;
		return {
			version: STORE_VERSION,
			lastUpdateId: parsed.lastUpdateId ?? null,
			botId: parsed.version === STORE_VERSION ? parsed.botId ?? null : null
		};
	} catch {
		return null;
	}
}
async function readTelegramUpdateOffset(params) {
	const filePath = resolveTelegramUpdateOffsetPath(params.accountId, params.env);
	try {
		const parsed = safeParseState(await fs.readFile(filePath, "utf-8"));
		const expectedBotId = extractBotIdFromToken(params.botToken);
		if (expectedBotId && parsed?.botId && parsed.botId !== expectedBotId) return null;
		if (expectedBotId && parsed?.botId === null) return null;
		return parsed?.lastUpdateId ?? null;
	} catch (err) {
		if (err.code === "ENOENT") return null;
		return null;
	}
}
async function writeTelegramUpdateOffset(params) {
	if (!isValidUpdateId(params.updateId)) throw new Error("Telegram update offset must be a non-negative safe integer.");
	await writeJsonAtomic(resolveTelegramUpdateOffsetPath(params.accountId, params.env), {
		version: STORE_VERSION,
		lastUpdateId: params.updateId,
		botId: extractBotIdFromToken(params.botToken)
	}, {
		mode: 384,
		trailingNewline: true,
		ensureDirMode: 448
	});
}
async function deleteTelegramUpdateOffset(params) {
	const filePath = resolveTelegramUpdateOffsetPath(params.accountId, params.env);
	try {
		await fs.unlink(filePath);
	} catch (err) {
		if (err.code === "ENOENT") return;
		throw err;
	}
}
//#endregion
export { readTelegramUpdateOffset as n, writeTelegramUpdateOffset as r, deleteTelegramUpdateOffset as t };
