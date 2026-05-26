import { y as resolveStateDir } from "./paths-Cw7f9XhU.js";
import { i as writeJsonFileAtomically, n as readJsonFileWithFallback } from "./json-store-ChgPP2Sf.js";
import "./state-paths-iYyQ0JoC.js";
import { t as fingerprintTelegramBotToken } from "./token-fingerprint-5R81vEJi.js";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
//#region extensions/telegram/src/update-offset-store.ts
const STORE_VERSION = 3;
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
function fingerprintFromToken(token) {
	const trimmed = token?.trim();
	if (!trimmed) return null;
	return fingerprintTelegramBotToken(trimmed);
}
function safeParseState(parsed) {
	try {
		const state = parsed;
		if (state?.version !== STORE_VERSION && state?.version !== 2 && state?.version !== 1) return null;
		if (state.lastUpdateId !== null && !isValidUpdateId(state.lastUpdateId)) return null;
		if (state.version >= 2 && state.botId !== null && typeof state.botId !== "string") return null;
		if (state.version === STORE_VERSION && state.tokenFingerprint !== null && typeof state.tokenFingerprint !== "string") return null;
		return {
			version: state.version,
			lastUpdateId: state.lastUpdateId ?? null,
			botId: state.version >= 2 ? state.botId ?? null : null,
			tokenFingerprint: state.version === STORE_VERSION ? state.tokenFingerprint ?? null : null
		};
	} catch {
		return null;
	}
}
function rotationForToken(parsed, botToken) {
	const currentBotId = extractBotIdFromToken(botToken);
	if (!currentBotId || parsed.lastUpdateId === null) return null;
	let reason = null;
	if (parsed.botId === null) reason = "legacy-state";
	else if (parsed.botId !== currentBotId) reason = "bot-id-changed";
	else if (parsed.tokenFingerprint === null) reason = "legacy-state";
	else if (parsed.tokenFingerprint !== fingerprintFromToken(botToken)) reason = "token-rotated";
	return reason ? {
		reason,
		previousBotId: parsed.botId,
		currentBotId,
		staleLastUpdateId: parsed.lastUpdateId
	} : null;
}
async function readTelegramUpdateOffset(params) {
	const { value } = await readJsonFileWithFallback(resolveTelegramUpdateOffsetPath(params.accountId, params.env), null);
	const parsed = safeParseState(value);
	if (!parsed) return null;
	const rotation = rotationForToken(parsed, params.botToken);
	if (rotation) {
		await params.onRotationDetected?.(rotation);
		return null;
	}
	return parsed.lastUpdateId;
}
async function writeTelegramUpdateOffset(params) {
	if (!isValidUpdateId(params.updateId)) throw new Error("Telegram update offset must be a non-negative safe integer.");
	await writeJsonFileAtomically(resolveTelegramUpdateOffsetPath(params.accountId, params.env), {
		version: STORE_VERSION,
		lastUpdateId: params.updateId,
		botId: extractBotIdFromToken(params.botToken),
		tokenFingerprint: fingerprintFromToken(params.botToken)
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
