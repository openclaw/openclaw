import { v as resolveStateDir } from "./paths-Cnwfh6dH.js";
import { i as writeJsonFileAtomically, n as readJsonFileWithFallback } from "./json-store-BUuXUY1y.js";
import "./state-paths-DTRyq4vN.js";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
//#region extensions/telegram/src/update-offset-store.ts
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
function safeParseState(parsed) {
	try {
		const state = parsed;
		if (state?.version !== STORE_VERSION && state?.version !== 1) return null;
		if (state.lastUpdateId !== null && !isValidUpdateId(state.lastUpdateId)) return null;
		if (state.version === STORE_VERSION && state.botId !== null && typeof state.botId !== "string") return null;
		return {
			version: STORE_VERSION,
			lastUpdateId: state.lastUpdateId ?? null,
			botId: state.version === STORE_VERSION ? state.botId ?? null : null
		};
	} catch {
		return null;
	}
}
async function readTelegramUpdateOffset(params) {
	const { value } = await readJsonFileWithFallback(resolveTelegramUpdateOffsetPath(params.accountId, params.env), null);
	const parsed = safeParseState(value);
	const expectedBotId = extractBotIdFromToken(params.botToken);
	if (expectedBotId && parsed?.botId && parsed.botId !== expectedBotId) return null;
	if (expectedBotId && parsed?.botId === null) return null;
	return parsed?.lastUpdateId ?? null;
}
async function writeTelegramUpdateOffset(params) {
	if (!isValidUpdateId(params.updateId)) throw new Error("Telegram update offset must be a non-negative safe integer.");
	await writeJsonFileAtomically(resolveTelegramUpdateOffsetPath(params.accountId, params.env), {
		version: STORE_VERSION,
		lastUpdateId: params.updateId,
		botId: extractBotIdFromToken(params.botToken)
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
