import { t as __exportAll } from "./rolldown-runtime-Cbj13DAv.js";
import { f as DEFAULT_ACCOUNT_ID, p as normalizeAccountId } from "./session-key-47BV2tLd.js";
import { a as resolveOAuthDir, c as expandHomePrefix, s as resolveStateDir, u as resolveRequiredHomeDir } from "./paths-DVWx7USN.js";
import { Bt as resolveTelegramPreviewStreamMode, i as readConfigFileSnapshotForWrite, jn as withFileLock$1, n as loadConfig, o as writeConfigFile } from "./config-DunvA-uZ.js";
import { $ as logVerbose, O as CONFIG_DIR, U as safeParseJson, Z as danger, t as createSubsystemLogger } from "./subsystem-B0uKDnzH.js";
import { r as isTruthyEnvValue } from "./command-format-BVkj1PMu.js";
import { D as resolveTelegramAccount, n as listChannelPlugins, t as getChannelPlugin } from "./plugins-D_msJzdO.js";
import { t as resolveFetch } from "./fetch-xPrdcvuh.js";
import { t as redactSensitiveText } from "./redact-NupjZUMH.js";
import { n as formatErrorMessage, r as formatUncaughtError, t as extractErrorCode } from "./errors-WrhqJ_d4.js";
import { i as createTelegramRetryRunner, n as recordChannelActivity } from "./channel-activity-CHyWM9wa.js";
import { n as normalizePollInput } from "./polls-DN23oxyB.js";
import { h as normalizeMimeType, p as isGifMedia, u as getFileExtension, v as mediaKindFromMime } from "./image-ops-C5t1cRmC.js";
import { a as loadWebMedia, n as markdownToIR, t as chunkMarkdownIR } from "./ir-DSH0voN3.js";
import { n as resolveMarkdownTableMode } from "./markdown-tables-B31KzXG_.js";
import { t as renderMarkdownWithMarkers } from "./render-Dk3zVolZ.js";
import { t as makeProxyFetch } from "./proxy-CLEew2L6.js";
import fs, { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import fs$1 from "node:fs/promises";
import crypto from "node:crypto";
import json5 from "json5";
import { Agent, setGlobalDispatcher } from "undici";
import * as dns from "node:dns";
import * as net$1 from "node:net";
import process$1 from "node:process";
import { Bot, HttpError, InputFile } from "grammy";

//#region src/channels/allow-from.ts
function mergeDmAllowFromSources(params) {
	const storeEntries = params.dmPolicy === "allowlist" ? [] : params.storeAllowFrom ?? [];
	return [...params.allowFrom ?? [], ...storeEntries].map((value) => String(value).trim()).filter(Boolean);
}
function resolveGroupAllowFromSources(params) {
	const explicitGroupAllowFrom = Array.isArray(params.groupAllowFrom) && params.groupAllowFrom.length > 0 ? params.groupAllowFrom : void 0;
	return (explicitGroupAllowFrom ? explicitGroupAllowFrom : params.fallbackToAllowFrom === false ? [] : params.allowFrom ?? []).map((value) => String(value).trim()).filter(Boolean);
}
function firstDefined(...values) {
	for (const value of values) if (typeof value !== "undefined") return value;
}
function isSenderIdAllowed(allow, senderId, allowWhenEmpty) {
	if (!allow.hasEntries) return allowWhenEmpty;
	if (allow.hasWildcard) return true;
	if (!senderId) return false;
	return allow.entries.includes(senderId);
}

//#endregion
//#region src/channels/plugins/pairing.ts
function listPairingChannels() {
	return listChannelPlugins().filter((plugin) => plugin.pairing).map((plugin) => plugin.id);
}
function getPairingAdapter(channelId) {
	return getChannelPlugin(channelId)?.pairing ?? null;
}

//#endregion
//#region src/plugin-sdk/json-store.ts
async function readJsonFileWithFallback(filePath, fallback) {
	try {
		const parsed = safeParseJson(await fs.promises.readFile(filePath, "utf-8"));
		if (parsed == null) return {
			value: fallback,
			exists: true
		};
		return {
			value: parsed,
			exists: true
		};
	} catch (err) {
		if (err.code === "ENOENT") return {
			value: fallback,
			exists: false
		};
		return {
			value: fallback,
			exists: false
		};
	}
}
async function writeJsonFileAtomically(filePath, value) {
	const dir = path.dirname(filePath);
	await fs.promises.mkdir(dir, {
		recursive: true,
		mode: 448
	});
	const tmp = path.join(dir, `${path.basename(filePath)}.${crypto.randomUUID()}.tmp`);
	await fs.promises.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf-8" });
	await fs.promises.chmod(tmp, 384);
	await fs.promises.rename(tmp, filePath);
}

//#endregion
//#region src/pairing/pairing-store.ts
const PAIRING_CODE_LENGTH = 8;
const PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PAIRING_PENDING_TTL_MS = 3600 * 1e3;
const PAIRING_PENDING_MAX = 3;
const PAIRING_STORE_LOCK_OPTIONS = {
	retries: {
		retries: 10,
		factor: 2,
		minTimeout: 100,
		maxTimeout: 1e4,
		randomize: true
	},
	stale: 3e4
};
function resolveCredentialsDir(env = process.env) {
	return resolveOAuthDir(env, resolveStateDir(env, () => resolveRequiredHomeDir(env, os.homedir)));
}
/** Sanitize channel ID for use in filenames (prevent path traversal). */
function safeChannelKey(channel) {
	const raw = String(channel).trim().toLowerCase();
	if (!raw) throw new Error("invalid pairing channel");
	const safe = raw.replace(/[\\/:*?"<>|]/g, "_").replace(/\.\./g, "_");
	if (!safe || safe === "_") throw new Error("invalid pairing channel");
	return safe;
}
function resolvePairingPath(channel, env = process.env) {
	return path.join(resolveCredentialsDir(env), `${safeChannelKey(channel)}-pairing.json`);
}
function safeAccountKey(accountId) {
	const raw = String(accountId).trim().toLowerCase();
	if (!raw) throw new Error("invalid pairing account id");
	const safe = raw.replace(/[\\/:*?"<>|]/g, "_").replace(/\.\./g, "_");
	if (!safe || safe === "_") throw new Error("invalid pairing account id");
	return safe;
}
function resolveAllowFromPath(channel, env = process.env, accountId) {
	const base = safeChannelKey(channel);
	const normalizedAccountId = typeof accountId === "string" ? accountId.trim() : "";
	if (!normalizedAccountId) return path.join(resolveCredentialsDir(env), `${base}-allowFrom.json`);
	return path.join(resolveCredentialsDir(env), `${base}-${safeAccountKey(normalizedAccountId)}-allowFrom.json`);
}
async function readJsonFile(filePath, fallback) {
	return await readJsonFileWithFallback(filePath, fallback);
}
async function writeJsonFile(filePath, value) {
	await writeJsonFileAtomically(filePath, value);
}
async function readPairingRequests(filePath) {
	const { value } = await readJsonFile(filePath, {
		version: 1,
		requests: []
	});
	return Array.isArray(value.requests) ? value.requests : [];
}
async function ensureJsonFile(filePath, fallback) {
	try {
		await fs.promises.access(filePath);
	} catch {
		await writeJsonFile(filePath, fallback);
	}
}
async function withFileLock(filePath, fallback, fn) {
	await ensureJsonFile(filePath, fallback);
	return await withFileLock$1(filePath, PAIRING_STORE_LOCK_OPTIONS, async () => {
		return await fn();
	});
}
function parseTimestamp(value) {
	if (!value) return null;
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed)) return null;
	return parsed;
}
function isExpired(entry, nowMs) {
	const createdAt = parseTimestamp(entry.createdAt);
	if (!createdAt) return true;
	return nowMs - createdAt > PAIRING_PENDING_TTL_MS;
}
function pruneExpiredRequests(reqs, nowMs) {
	const kept = [];
	let removed = false;
	for (const req of reqs) {
		if (isExpired(req, nowMs)) {
			removed = true;
			continue;
		}
		kept.push(req);
	}
	return {
		requests: kept,
		removed
	};
}
function resolveLastSeenAt(entry) {
	return parseTimestamp(entry.lastSeenAt) ?? parseTimestamp(entry.createdAt) ?? 0;
}
function pruneExcessRequests(reqs, maxPending) {
	if (maxPending <= 0 || reqs.length <= maxPending) return {
		requests: reqs,
		removed: false
	};
	return {
		requests: reqs.slice().toSorted((a, b) => resolveLastSeenAt(a) - resolveLastSeenAt(b)).slice(-maxPending),
		removed: true
	};
}
function randomCode() {
	let out = "";
	for (let i = 0; i < PAIRING_CODE_LENGTH; i++) {
		const idx = crypto.randomInt(0, 32);
		out += PAIRING_CODE_ALPHABET[idx];
	}
	return out;
}
function generateUniqueCode(existing) {
	for (let attempt = 0; attempt < 500; attempt += 1) {
		const code = randomCode();
		if (!existing.has(code)) return code;
	}
	throw new Error("failed to generate unique pairing code");
}
function normalizePairingAccountId(accountId) {
	return accountId?.trim().toLowerCase() || "";
}
function requestMatchesAccountId(entry, normalizedAccountId) {
	if (!normalizedAccountId) return true;
	return String(entry.meta?.accountId ?? "").trim().toLowerCase() === normalizedAccountId;
}
function shouldIncludeLegacyAllowFromEntries(normalizedAccountId) {
	return !normalizedAccountId || normalizedAccountId === DEFAULT_ACCOUNT_ID;
}
function normalizeId(value) {
	return String(value).trim();
}
function normalizeAllowEntry(channel, entry) {
	const trimmed = entry.trim();
	if (!trimmed) return "";
	if (trimmed === "*") return "";
	const adapter = getPairingAdapter(channel);
	const normalized = adapter?.normalizeAllowEntry ? adapter.normalizeAllowEntry(trimmed) : trimmed;
	return String(normalized).trim();
}
function normalizeAllowFromList(channel, store) {
	return dedupePreserveOrder((Array.isArray(store.allowFrom) ? store.allowFrom : []).map((v) => normalizeAllowEntry(channel, String(v))).filter(Boolean));
}
function normalizeAllowFromInput(channel, entry) {
	return normalizeAllowEntry(channel, normalizeId(entry));
}
function dedupePreserveOrder(entries) {
	const seen = /* @__PURE__ */ new Set();
	const out = [];
	for (const entry of entries) {
		const normalized = String(entry).trim();
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		out.push(normalized);
	}
	return out;
}
async function readAllowFromStateForPath(channel, filePath) {
	return (await readAllowFromStateForPathWithExists(channel, filePath)).entries;
}
async function readAllowFromStateForPathWithExists(channel, filePath) {
	const { value, exists } = await readJsonFile(filePath, {
		version: 1,
		allowFrom: []
	});
	return {
		entries: normalizeAllowFromList(channel, value),
		exists
	};
}
function readAllowFromStateForPathSync(channel, filePath) {
	return readAllowFromStateForPathSyncWithExists(channel, filePath).entries;
}
function readAllowFromStateForPathSyncWithExists(channel, filePath) {
	let raw = "";
	try {
		raw = fs.readFileSync(filePath, "utf8");
	} catch (err) {
		if (err.code === "ENOENT") return {
			entries: [],
			exists: false
		};
		return {
			entries: [],
			exists: false
		};
	}
	try {
		return {
			entries: normalizeAllowFromList(channel, JSON.parse(raw)),
			exists: true
		};
	} catch {
		return {
			entries: [],
			exists: true
		};
	}
}
async function readAllowFromState(params) {
	const { value } = await readJsonFile(params.filePath, {
		version: 1,
		allowFrom: []
	});
	return {
		current: normalizeAllowFromList(params.channel, value),
		normalized: normalizeAllowFromInput(params.channel, params.entry) || null
	};
}
async function writeAllowFromState(filePath, allowFrom) {
	await writeJsonFile(filePath, {
		version: 1,
		allowFrom
	});
}
async function readNonDefaultAccountAllowFrom(params) {
	const scopedPath = resolveAllowFromPath(params.channel, params.env, params.accountId);
	return await readAllowFromStateForPath(params.channel, scopedPath);
}
function readNonDefaultAccountAllowFromSync(params) {
	const scopedPath = resolveAllowFromPath(params.channel, params.env, params.accountId);
	return readAllowFromStateForPathSync(params.channel, scopedPath);
}
async function updateAllowFromStoreEntry(params) {
	const env = params.env ?? process.env;
	const filePath = resolveAllowFromPath(params.channel, env, params.accountId);
	return await withFileLock(filePath, {
		version: 1,
		allowFrom: []
	}, async () => {
		const { current, normalized } = await readAllowFromState({
			channel: params.channel,
			entry: params.entry,
			filePath
		});
		if (!normalized) return {
			changed: false,
			allowFrom: current
		};
		const next = params.apply(current, normalized);
		if (!next) return {
			changed: false,
			allowFrom: current
		};
		await writeAllowFromState(filePath, next);
		return {
			changed: true,
			allowFrom: next
		};
	});
}
async function readChannelAllowFromStore(channel, env = process.env, accountId) {
	const resolvedAccountId = accountId.trim().toLowerCase() || DEFAULT_ACCOUNT_ID;
	if (!shouldIncludeLegacyAllowFromEntries(resolvedAccountId)) return await readNonDefaultAccountAllowFrom({
		channel,
		env,
		accountId: resolvedAccountId
	});
	const scopedEntries = await readAllowFromStateForPath(channel, resolveAllowFromPath(channel, env, resolvedAccountId));
	const legacyEntries = await readAllowFromStateForPath(channel, resolveAllowFromPath(channel, env));
	return dedupePreserveOrder([...scopedEntries, ...legacyEntries]);
}
function readChannelAllowFromStoreSync(channel, env = process.env, accountId) {
	const resolvedAccountId = accountId.trim().toLowerCase() || DEFAULT_ACCOUNT_ID;
	if (!shouldIncludeLegacyAllowFromEntries(resolvedAccountId)) return readNonDefaultAccountAllowFromSync({
		channel,
		env,
		accountId: resolvedAccountId
	});
	const scopedEntries = readAllowFromStateForPathSync(channel, resolveAllowFromPath(channel, env, resolvedAccountId));
	const legacyEntries = readAllowFromStateForPathSync(channel, resolveAllowFromPath(channel, env));
	return dedupePreserveOrder([...scopedEntries, ...legacyEntries]);
}
async function updateChannelAllowFromStore(params) {
	return await updateAllowFromStoreEntry({
		channel: params.channel,
		entry: params.entry,
		accountId: params.accountId,
		env: params.env,
		apply: params.apply
	});
}
async function mutateChannelAllowFromStoreEntry(params, apply) {
	return await updateChannelAllowFromStore({
		...params,
		apply
	});
}
async function addChannelAllowFromStoreEntry(params) {
	return await mutateChannelAllowFromStoreEntry(params, (current, normalized) => {
		if (current.includes(normalized)) return null;
		return [...current, normalized];
	});
}
async function removeChannelAllowFromStoreEntry(params) {
	return await mutateChannelAllowFromStoreEntry(params, (current, normalized) => {
		const next = current.filter((entry) => entry !== normalized);
		if (next.length === current.length) return null;
		return next;
	});
}
async function upsertChannelPairingRequest(params) {
	const env = params.env ?? process.env;
	const filePath = resolvePairingPath(params.channel, env);
	return await withFileLock(filePath, {
		version: 1,
		requests: []
	}, async () => {
		const now = (/* @__PURE__ */ new Date()).toISOString();
		const nowMs = Date.now();
		const id = normalizeId(params.id);
		const normalizedAccountId = normalizePairingAccountId(params.accountId) || DEFAULT_ACCOUNT_ID;
		const meta = {
			...params.meta && typeof params.meta === "object" ? Object.fromEntries(Object.entries(params.meta).map(([k, v]) => [k, String(v ?? "").trim()]).filter(([_, v]) => Boolean(v))) : void 0,
			accountId: normalizedAccountId
		};
		let reqs = await readPairingRequests(filePath);
		const { requests: prunedExpired, removed: expiredRemoved } = pruneExpiredRequests(reqs, nowMs);
		reqs = prunedExpired;
		const normalizedMatchingAccountId = normalizedAccountId;
		const existingIdx = reqs.findIndex((r) => {
			if (r.id !== id) return false;
			return requestMatchesAccountId(r, normalizedMatchingAccountId);
		});
		const existingCodes = new Set(reqs.map((req) => String(req.code ?? "").trim().toUpperCase()));
		if (existingIdx >= 0) {
			const existing = reqs[existingIdx];
			const code = (existing && typeof existing.code === "string" ? existing.code.trim() : "") || generateUniqueCode(existingCodes);
			const next = {
				id,
				code,
				createdAt: existing?.createdAt ?? now,
				lastSeenAt: now,
				meta: meta ?? existing?.meta
			};
			reqs[existingIdx] = next;
			const { requests: capped } = pruneExcessRequests(reqs, PAIRING_PENDING_MAX);
			await writeJsonFile(filePath, {
				version: 1,
				requests: capped
			});
			return {
				code,
				created: false
			};
		}
		const { requests: capped, removed: cappedRemoved } = pruneExcessRequests(reqs, PAIRING_PENDING_MAX);
		reqs = capped;
		if (PAIRING_PENDING_MAX > 0 && reqs.length >= PAIRING_PENDING_MAX) {
			if (expiredRemoved || cappedRemoved) await writeJsonFile(filePath, {
				version: 1,
				requests: reqs
			});
			return {
				code: "",
				created: false
			};
		}
		const code = generateUniqueCode(existingCodes);
		const next = {
			id,
			code,
			createdAt: now,
			lastSeenAt: now,
			...meta ? { meta } : {}
		};
		await writeJsonFile(filePath, {
			version: 1,
			requests: [...reqs, next]
		});
		return {
			code,
			created: true
		};
	});
}

//#endregion
//#region src/infra/wsl.ts
function isWSLEnv() {
	if (process.env.WSL_INTEROP || process.env.WSL_DISTRO_NAME || process.env.WSLENV) return true;
	return false;
}
/**
* Synchronously check if running in WSL.
* Checks env vars first, then /proc/version.
*/
function isWSLSync() {
	if (process.platform !== "linux") return false;
	if (isWSLEnv()) return true;
	try {
		const release = readFileSync("/proc/version", "utf8").toLowerCase();
		return release.includes("microsoft") || release.includes("wsl");
	} catch {
		return false;
	}
}
/**
* Synchronously check if running in WSL2.
*/
function isWSL2Sync() {
	if (!isWSLSync()) return false;
	try {
		const version = readFileSync("/proc/version", "utf8").toLowerCase();
		return version.includes("wsl2") || version.includes("microsoft-standard");
	} catch {
		return false;
	}
}

//#endregion
//#region src/channels/location.ts
function resolveLocation(location) {
	const source = location.source ?? (location.isLive ? "live" : location.name || location.address ? "place" : "pin");
	const isLive = Boolean(location.isLive ?? source === "live");
	return {
		...location,
		source,
		isLive
	};
}
function formatAccuracy(accuracy) {
	if (!Number.isFinite(accuracy)) return "";
	return ` ±${Math.round(accuracy ?? 0)}m`;
}
function formatCoords(latitude, longitude) {
	return `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;
}
function formatLocationText(location) {
	const resolved = resolveLocation(location);
	const coords = formatCoords(resolved.latitude, resolved.longitude);
	const accuracy = formatAccuracy(resolved.accuracy);
	const caption = resolved.caption?.trim();
	let header = "";
	if (resolved.source === "live" || resolved.isLive) header = `🛰 Live location: ${coords}${accuracy}`;
	else if (resolved.name || resolved.address) header = `📍 ${[resolved.name, resolved.address].filter(Boolean).join(" — ")} (${coords}${accuracy})`;
	else header = `📍 ${coords}${accuracy}`;
	return caption ? `${header}\n${caption}` : header;
}
function toLocationContext(location) {
	const resolved = resolveLocation(location);
	return {
		LocationLat: resolved.latitude,
		LocationLon: resolved.longitude,
		LocationAccuracy: resolved.accuracy,
		LocationName: resolved.name,
		LocationAddress: resolved.address,
		LocationSource: resolved.source,
		LocationIsLive: resolved.isLive
	};
}

//#endregion
//#region src/telegram/targets.ts
const TELEGRAM_NUMERIC_CHAT_ID_REGEX = /^-?\d+$/;
const TELEGRAM_USERNAME_REGEX = /^[A-Za-z0-9_]{5,}$/i;
function stripTelegramInternalPrefixes(to) {
	let trimmed = to.trim();
	let strippedTelegramPrefix = false;
	while (true) {
		const next = (() => {
			if (/^(telegram|tg):/i.test(trimmed)) {
				strippedTelegramPrefix = true;
				return trimmed.replace(/^(telegram|tg):/i, "").trim();
			}
			if (strippedTelegramPrefix && /^group:/i.test(trimmed)) return trimmed.replace(/^group:/i, "").trim();
			return trimmed;
		})();
		if (next === trimmed) return trimmed;
		trimmed = next;
	}
}
function normalizeTelegramChatId(raw) {
	const stripped = stripTelegramInternalPrefixes(raw);
	if (!stripped) return;
	if (TELEGRAM_NUMERIC_CHAT_ID_REGEX.test(stripped)) return stripped;
}
function isNumericTelegramChatId(raw) {
	return TELEGRAM_NUMERIC_CHAT_ID_REGEX.test(raw.trim());
}
function normalizeTelegramLookupTarget(raw) {
	const stripped = stripTelegramInternalPrefixes(raw);
	if (!stripped) return;
	if (isNumericTelegramChatId(stripped)) return stripped;
	const tmeMatch = /^(?:https?:\/\/)?t\.me\/([A-Za-z0-9_]+)$/i.exec(stripped);
	if (tmeMatch?.[1]) return `@${tmeMatch[1]}`;
	if (stripped.startsWith("@")) {
		const handle = stripped.slice(1);
		if (!handle || !TELEGRAM_USERNAME_REGEX.test(handle)) return;
		return `@${handle}`;
	}
	if (TELEGRAM_USERNAME_REGEX.test(stripped)) return `@${stripped}`;
}
/**
* Parse a Telegram delivery target into chatId and optional topic/thread ID.
*
* Supported formats:
* - `chatId` (plain chat ID, t.me link, @username, or internal prefixes like `telegram:...`)
* - `chatId:topicId` (numeric topic/thread ID)
* - `chatId:topic:topicId` (explicit topic marker; preferred)
*/
function resolveTelegramChatType(chatId) {
	const trimmed = chatId.trim();
	if (!trimmed) return "unknown";
	if (isNumericTelegramChatId(trimmed)) return trimmed.startsWith("-") ? "group" : "direct";
	return "unknown";
}
function parseTelegramTarget(to) {
	const normalized = stripTelegramInternalPrefixes(to);
	const topicMatch = /^(.+?):topic:(\d+)$/.exec(normalized);
	if (topicMatch) return {
		chatId: topicMatch[1],
		messageThreadId: Number.parseInt(topicMatch[2], 10),
		chatType: resolveTelegramChatType(topicMatch[1])
	};
	const colonMatch = /^(.+):(\d+)$/.exec(normalized);
	if (colonMatch) return {
		chatId: colonMatch[1],
		messageThreadId: Number.parseInt(colonMatch[2], 10),
		chatType: resolveTelegramChatType(colonMatch[1])
	};
	return {
		chatId: normalized,
		chatType: resolveTelegramChatType(normalized)
	};
}
function resolveTelegramTargetChatType(target) {
	return parseTelegramTarget(target).chatType;
}

//#endregion
//#region src/media/audio.ts
const TELEGRAM_VOICE_AUDIO_EXTENSIONS = new Set([
	".oga",
	".ogg",
	".opus",
	".mp3",
	".m4a"
]);
/**
* MIME types compatible with voice messages.
* Telegram sendVoice supports OGG/Opus, MP3, and M4A.
* https://core.telegram.org/bots/api#sendvoice
*/
const TELEGRAM_VOICE_MIME_TYPES = new Set([
	"audio/ogg",
	"audio/opus",
	"audio/mpeg",
	"audio/mp3",
	"audio/mp4",
	"audio/x-m4a",
	"audio/m4a"
]);
function isTelegramVoiceCompatibleAudio(opts) {
	const mime = normalizeMimeType(opts.contentType);
	if (mime && TELEGRAM_VOICE_MIME_TYPES.has(mime)) return true;
	const fileName = opts.fileName?.trim();
	if (!fileName) return false;
	const ext = getFileExtension(fileName);
	if (!ext) return false;
	return TELEGRAM_VOICE_AUDIO_EXTENSIONS.has(ext);
}
/**
* Backward-compatible alias used across plugin/runtime call sites.
* Keeps existing behavior while making Telegram-specific policy explicit.
*/
function isVoiceCompatibleAudio(opts) {
	return isTelegramVoiceCompatibleAudio(opts);
}

//#endregion
//#region src/infra/diagnostic-flags.ts
const DIAGNOSTICS_ENV = "OPENCLAW_DIAGNOSTICS";
function normalizeFlag(value) {
	return value.trim().toLowerCase();
}
function parseEnvFlags(raw) {
	if (!raw) return [];
	const trimmed = raw.trim();
	if (!trimmed) return [];
	const lowered = trimmed.toLowerCase();
	if ([
		"0",
		"false",
		"off",
		"none"
	].includes(lowered)) return [];
	if ([
		"1",
		"true",
		"all",
		"*"
	].includes(lowered)) return ["*"];
	return trimmed.split(/[,\s]+/).map(normalizeFlag).filter(Boolean);
}
function uniqueFlags(flags) {
	const seen = /* @__PURE__ */ new Set();
	const out = [];
	for (const flag of flags) {
		const normalized = normalizeFlag(flag);
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		out.push(normalized);
	}
	return out;
}
function resolveDiagnosticFlags(cfg, env = process.env) {
	const configFlags = Array.isArray(cfg?.diagnostics?.flags) ? cfg?.diagnostics?.flags : [];
	const envFlags = parseEnvFlags(env[DIAGNOSTICS_ENV]);
	return uniqueFlags([...configFlags, ...envFlags]);
}
function matchesDiagnosticFlag(flag, enabledFlags) {
	const target = normalizeFlag(flag);
	if (!target) return false;
	for (const raw of enabledFlags) {
		const enabled = normalizeFlag(raw);
		if (!enabled) continue;
		if (enabled === "*" || enabled === "all") return true;
		if (enabled.endsWith(".*")) {
			const prefix = enabled.slice(0, -2);
			if (target === prefix || target.startsWith(`${prefix}.`)) return true;
		}
		if (enabled.endsWith("*")) {
			const prefix = enabled.slice(0, -1);
			if (target.startsWith(prefix)) return true;
		}
		if (enabled === target) return true;
	}
	return false;
}
function isDiagnosticFlagEnabled(flag, cfg, env = process.env) {
	return matchesDiagnosticFlag(flag, resolveDiagnosticFlags(cfg, env));
}

//#endregion
//#region src/telegram/api-logging.ts
const fallbackLogger = createSubsystemLogger("telegram/api");
function resolveTelegramApiLogger(runtime, logger) {
	if (logger) return logger;
	if (runtime?.error) return runtime.error;
	return (message) => fallbackLogger.error(message);
}
async function withTelegramApiErrorLogging({ operation, fn, runtime, logger, shouldLog }) {
	try {
		return await fn();
	} catch (err) {
		if (!shouldLog || shouldLog(err)) {
			const errText = formatErrorMessage(err);
			resolveTelegramApiLogger(runtime, logger)(danger(`telegram ${operation} failed: ${errText}`));
		}
		throw err;
	}
}

//#endregion
//#region src/telegram/bot-access.ts
const warnedInvalidEntries = /* @__PURE__ */ new Set();
const log$1 = createSubsystemLogger("telegram/bot-access");
function warnInvalidAllowFromEntries(entries) {
	if (process.env.VITEST || false) return;
	for (const entry of entries) {
		if (warnedInvalidEntries.has(entry)) continue;
		warnedInvalidEntries.add(entry);
		log$1.warn([
			"Invalid allowFrom entry:",
			JSON.stringify(entry),
			"- allowFrom/groupAllowFrom authorization requires numeric Telegram sender IDs only.",
			"If you had \"@username\" entries, re-run onboarding (it resolves @username to IDs) or replace them manually."
		].join(" "));
	}
}
const normalizeAllowFrom = (list) => {
	const entries = (list ?? []).map((value) => String(value).trim()).filter(Boolean);
	const hasWildcard = entries.includes("*");
	const normalized = entries.filter((value) => value !== "*").map((value) => value.replace(/^(telegram|tg):/i, ""));
	const invalidEntries = normalized.filter((value) => !/^\d+$/.test(value));
	if (invalidEntries.length > 0) warnInvalidAllowFromEntries([...new Set(invalidEntries)]);
	return {
		entries: normalized.filter((value) => /^\d+$/.test(value)),
		hasWildcard,
		hasEntries: entries.length > 0,
		invalidEntries
	};
};
const normalizeDmAllowFromWithStore = (params) => normalizeAllowFrom(mergeDmAllowFromSources(params));
const isSenderAllowed = (params) => {
	const { allow, senderId } = params;
	return isSenderIdAllowed(allow, senderId, true);
};
const resolveSenderAllowMatch = (params) => {
	const { allow, senderId } = params;
	if (allow.hasWildcard) return {
		allowed: true,
		matchKey: "*",
		matchSource: "wildcard"
	};
	if (!allow.hasEntries) return { allowed: false };
	if (senderId && allow.entries.includes(senderId)) return {
		allowed: true,
		matchKey: senderId,
		matchSource: "id"
	};
	return { allowed: false };
};

//#endregion
//#region src/telegram/bot/helpers.ts
const TELEGRAM_GENERAL_TOPIC_ID = 1;
async function resolveTelegramGroupAllowFromContext(params) {
	const accountId = normalizeAccountId(params.accountId);
	const resolvedThreadId = resolveTelegramForumThreadId({
		isForum: params.isForum,
		messageThreadId: params.messageThreadId
	});
	const storeAllowFrom = await readChannelAllowFromStore("telegram", process.env, accountId).catch(() => []);
	const { groupConfig, topicConfig } = params.resolveTelegramGroupConfig(params.chatId, resolvedThreadId);
	const groupAllowOverride = firstDefined(topicConfig?.allowFrom, groupConfig?.allowFrom);
	return {
		resolvedThreadId,
		storeAllowFrom,
		groupConfig,
		topicConfig,
		groupAllowOverride,
		effectiveGroupAllow: normalizeAllowFrom(groupAllowOverride ?? params.groupAllowFrom),
		hasGroupAllowOverride: typeof groupAllowOverride !== "undefined"
	};
}
/**
* Resolve the thread ID for Telegram forum topics.
* For non-forum groups, returns undefined even if messageThreadId is present
* (reply threads in regular groups should not create separate sessions).
* For forum groups, returns the topic ID (or General topic ID=1 if unspecified).
*/
function resolveTelegramForumThreadId(params) {
	if (!params.isForum) return;
	if (params.messageThreadId == null) return TELEGRAM_GENERAL_TOPIC_ID;
	return params.messageThreadId;
}
function resolveTelegramThreadSpec(params) {
	if (params.isGroup) return {
		id: resolveTelegramForumThreadId({
			isForum: params.isForum,
			messageThreadId: params.messageThreadId
		}),
		scope: params.isForum ? "forum" : "none"
	};
	if (params.messageThreadId == null) return { scope: "dm" };
	return {
		id: params.messageThreadId,
		scope: "dm"
	};
}
/**
* Build thread params for Telegram API calls (messages, media).
*
* IMPORTANT: Thread IDs behave differently based on chat type:
* - DMs (private chats): Include message_thread_id when present (DM topics)
* - Forum topics: Skip thread_id=1 (General topic), include others
* - Regular groups: Thread IDs are ignored by Telegram
*
* General forum topic (id=1) must be treated like a regular supergroup send:
* Telegram rejects sendMessage/sendMedia with message_thread_id=1 ("thread not found").
*
* @param thread - Thread specification with ID and scope
* @returns API params object or undefined if thread_id should be omitted
*/
function buildTelegramThreadParams(thread) {
	if (thread?.id == null) return;
	const normalized = Math.trunc(thread.id);
	if (thread.scope === "dm") return normalized > 0 ? { message_thread_id: normalized } : void 0;
	if (normalized === TELEGRAM_GENERAL_TOPIC_ID) return;
	return { message_thread_id: normalized };
}
/**
* Build thread params for typing indicators (sendChatAction).
* Empirically, General topic (id=1) needs message_thread_id for typing to appear.
*/
function buildTypingThreadParams(messageThreadId) {
	if (messageThreadId == null) return;
	return { message_thread_id: Math.trunc(messageThreadId) };
}
function resolveTelegramStreamMode(telegramCfg) {
	return resolveTelegramPreviewStreamMode(telegramCfg);
}
function buildTelegramGroupPeerId(chatId, messageThreadId) {
	return messageThreadId != null ? `${chatId}:topic:${messageThreadId}` : String(chatId);
}
function buildTelegramGroupFrom(chatId, messageThreadId) {
	return `telegram:group:${buildTelegramGroupPeerId(chatId, messageThreadId)}`;
}
/**
* Build parentPeer for forum topic binding inheritance.
* When a message comes from a forum topic, the peer ID includes the topic suffix
* (e.g., `-1001234567890:topic:99`). To allow bindings configured for the base
* group ID to match, we provide the parent group as `parentPeer` so the routing
* layer can fall back to it when the exact peer doesn't match.
*/
function buildTelegramParentPeer(params) {
	if (!params.isGroup || params.resolvedThreadId == null) return;
	return {
		kind: "group",
		id: String(params.chatId)
	};
}
function buildSenderName(msg) {
	return [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ").trim() || msg.from?.username || void 0;
}
function resolveTelegramMediaPlaceholder(msg) {
	if (!msg) return;
	if (msg.photo) return "<media:image>";
	if (msg.video || msg.video_note) return "<media:video>";
	if (msg.audio || msg.voice) return "<media:audio>";
	if (msg.document) return "<media:document>";
	if (msg.sticker) return "<media:sticker>";
}
function buildSenderLabel(msg, senderId) {
	const name = buildSenderName(msg);
	const username = msg.from?.username ? `@${msg.from.username}` : void 0;
	let label = name;
	if (name && username) label = `${name} (${username})`;
	else if (!name && username) label = username;
	const fallbackId = (senderId != null && `${senderId}`.trim() ? `${senderId}`.trim() : void 0) ?? (msg.from?.id != null ? String(msg.from.id) : void 0);
	const idPart = fallbackId ? `id:${fallbackId}` : void 0;
	if (label && idPart) return `${label} ${idPart}`;
	if (label) return label;
	return idPart ?? "id:unknown";
}
function buildGroupLabel(msg, chatId, messageThreadId) {
	const title = msg.chat?.title;
	const topicSuffix = messageThreadId != null ? ` topic:${messageThreadId}` : "";
	if (title) return `${title} id:${chatId}${topicSuffix}`;
	return `group:${chatId}${topicSuffix}`;
}
function hasBotMention(msg, botUsername) {
	if ((msg.text ?? msg.caption ?? "").toLowerCase().includes(`@${botUsername}`)) return true;
	const entities = msg.entities ?? msg.caption_entities ?? [];
	for (const ent of entities) {
		if (ent.type !== "mention") continue;
		if ((msg.text ?? msg.caption ?? "").slice(ent.offset, ent.offset + ent.length).toLowerCase() === `@${botUsername}`) return true;
	}
	return false;
}
function expandTextLinks(text, entities) {
	if (!text || !entities?.length) return text;
	const textLinks = entities.filter((entity) => entity.type === "text_link" && Boolean(entity.url)).toSorted((a, b) => b.offset - a.offset);
	if (textLinks.length === 0) return text;
	let result = text;
	for (const entity of textLinks) {
		const markdown = `[${text.slice(entity.offset, entity.offset + entity.length)}](${entity.url})`;
		result = result.slice(0, entity.offset) + markdown + result.slice(entity.offset + entity.length);
	}
	return result;
}
function resolveTelegramReplyId(raw) {
	if (!raw) return;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed)) return;
	return parsed;
}
function describeReplyTarget(msg) {
	const reply = msg.reply_to_message;
	const externalReply = msg.external_reply;
	const quoteText = msg.quote?.text ?? externalReply?.quote?.text;
	let body = "";
	let kind = "reply";
	if (typeof quoteText === "string") {
		body = quoteText.trim();
		if (body) kind = "quote";
	}
	const replyLike = reply ?? externalReply;
	if (!body && replyLike) {
		body = (replyLike.text ?? replyLike.caption ?? "").trim();
		if (!body) {
			body = resolveTelegramMediaPlaceholder(replyLike) ?? "";
			if (!body) {
				const locationData = extractTelegramLocation(replyLike);
				if (locationData) body = formatLocationText(locationData);
			}
		}
	}
	if (!body) return null;
	const senderLabel = (replyLike ? buildSenderName(replyLike) : void 0) ?? "unknown sender";
	const forwardedFrom = replyLike?.forward_origin ? resolveForwardOrigin(replyLike.forward_origin) ?? void 0 : void 0;
	return {
		id: replyLike?.message_id ? String(replyLike.message_id) : void 0,
		sender: senderLabel,
		body,
		kind,
		forwardedFrom
	};
}
function normalizeForwardedUserLabel(user) {
	const name = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
	const username = user.username?.trim() || void 0;
	const id = String(user.id);
	return {
		display: (name && username ? `${name} (@${username})` : name || (username ? `@${username}` : void 0)) || `user:${id}`,
		name: name || void 0,
		username,
		id
	};
}
function normalizeForwardedChatLabel(chat, fallbackKind) {
	const title = chat.title?.trim() || void 0;
	const username = chat.username?.trim() || void 0;
	const id = String(chat.id);
	return {
		display: title || (username ? `@${username}` : void 0) || `${fallbackKind}:${id}`,
		title,
		username,
		id
	};
}
function buildForwardedContextFromUser(params) {
	const { display, name, username, id } = normalizeForwardedUserLabel(params.user);
	if (!display) return null;
	return {
		from: display,
		date: params.date,
		fromType: params.type,
		fromId: id,
		fromUsername: username,
		fromTitle: name
	};
}
function buildForwardedContextFromHiddenName(params) {
	const trimmed = params.name?.trim();
	if (!trimmed) return null;
	return {
		from: trimmed,
		date: params.date,
		fromType: params.type,
		fromTitle: trimmed
	};
}
function buildForwardedContextFromChat(params) {
	const fallbackKind = params.type === "channel" ? "channel" : "chat";
	const { display, title, username, id } = normalizeForwardedChatLabel(params.chat, fallbackKind);
	if (!display) return null;
	const signature = params.signature?.trim() || void 0;
	const from = signature ? `${display} (${signature})` : display;
	const chatType = params.chat.type?.trim() || void 0;
	return {
		from,
		date: params.date,
		fromType: params.type,
		fromId: id,
		fromUsername: username,
		fromTitle: title,
		fromSignature: signature,
		fromChatType: chatType,
		fromMessageId: params.messageId
	};
}
function resolveForwardOrigin(origin) {
	switch (origin.type) {
		case "user": return buildForwardedContextFromUser({
			user: origin.sender_user,
			date: origin.date,
			type: "user"
		});
		case "hidden_user": return buildForwardedContextFromHiddenName({
			name: origin.sender_user_name,
			date: origin.date,
			type: "hidden_user"
		});
		case "chat": return buildForwardedContextFromChat({
			chat: origin.sender_chat,
			date: origin.date,
			type: "chat",
			signature: origin.author_signature
		});
		case "channel": return buildForwardedContextFromChat({
			chat: origin.chat,
			date: origin.date,
			type: "channel",
			signature: origin.author_signature,
			messageId: origin.message_id
		});
		default: return null;
	}
}
/** Extract forwarded message origin info from Telegram message. */
function normalizeForwardedContext(msg) {
	if (!msg.forward_origin) return null;
	return resolveForwardOrigin(msg.forward_origin);
}
function extractTelegramLocation(msg) {
	const { venue, location } = msg;
	if (venue) return {
		latitude: venue.location.latitude,
		longitude: venue.location.longitude,
		accuracy: venue.location.horizontal_accuracy,
		name: venue.title,
		address: venue.address,
		source: "place",
		isLive: false
	};
	if (location) {
		const isLive = typeof location.live_period === "number" && location.live_period > 0;
		return {
			latitude: location.latitude,
			longitude: location.longitude,
			accuracy: location.horizontal_accuracy,
			source: isLive ? "live" : "pin",
			isLive
		};
	}
	return null;
}

//#endregion
//#region src/telegram/caption.ts
const TELEGRAM_MAX_CAPTION_LENGTH = 1024;
function splitTelegramCaption(text) {
	const trimmed = text?.trim() ?? "";
	if (!trimmed) return {
		caption: void 0,
		followUpText: void 0
	};
	if (trimmed.length > TELEGRAM_MAX_CAPTION_LENGTH) return {
		caption: void 0,
		followUpText: trimmed
	};
	return {
		caption: trimmed,
		followUpText: void 0
	};
}

//#endregion
//#region src/telegram/network-config.ts
const TELEGRAM_DISABLE_AUTO_SELECT_FAMILY_ENV = "OPENCLAW_TELEGRAM_DISABLE_AUTO_SELECT_FAMILY";
const TELEGRAM_ENABLE_AUTO_SELECT_FAMILY_ENV = "OPENCLAW_TELEGRAM_ENABLE_AUTO_SELECT_FAMILY";
const TELEGRAM_DNS_RESULT_ORDER_ENV = "OPENCLAW_TELEGRAM_DNS_RESULT_ORDER";
let wsl2SyncCache;
function isWSL2SyncCached() {
	if (typeof wsl2SyncCache === "boolean") return wsl2SyncCache;
	wsl2SyncCache = isWSL2Sync();
	return wsl2SyncCache;
}
function resolveTelegramAutoSelectFamilyDecision(params) {
	const env = params?.env ?? process$1.env;
	const nodeMajor = typeof params?.nodeMajor === "number" ? params.nodeMajor : Number(process$1.versions.node.split(".")[0]);
	if (isTruthyEnvValue(env[TELEGRAM_ENABLE_AUTO_SELECT_FAMILY_ENV])) return {
		value: true,
		source: `env:${TELEGRAM_ENABLE_AUTO_SELECT_FAMILY_ENV}`
	};
	if (isTruthyEnvValue(env[TELEGRAM_DISABLE_AUTO_SELECT_FAMILY_ENV])) return {
		value: false,
		source: `env:${TELEGRAM_DISABLE_AUTO_SELECT_FAMILY_ENV}`
	};
	if (typeof params?.network?.autoSelectFamily === "boolean") return {
		value: params.network.autoSelectFamily,
		source: "config"
	};
	if (isWSL2SyncCached()) return {
		value: false,
		source: "default-wsl2"
	};
	if (Number.isFinite(nodeMajor) && nodeMajor >= 22) return {
		value: true,
		source: "default-node22"
	};
	return { value: null };
}
/**
* Resolve DNS result order setting for Telegram network requests.
* Some networks/ISPs have issues with IPv6 causing fetch failures.
* Setting "ipv4first" prioritizes IPv4 addresses in DNS resolution.
*
* Priority:
* 1. Environment variable OPENCLAW_TELEGRAM_DNS_RESULT_ORDER
* 2. Config: channels.telegram.network.dnsResultOrder
* 3. Default: "ipv4first" on Node 22+ (to work around common IPv6 issues)
*/
function resolveTelegramDnsResultOrderDecision(params) {
	const env = params?.env ?? process$1.env;
	const nodeMajor = typeof params?.nodeMajor === "number" ? params.nodeMajor : Number(process$1.versions.node.split(".")[0]);
	const envValue = env[TELEGRAM_DNS_RESULT_ORDER_ENV]?.trim().toLowerCase();
	if (envValue === "ipv4first" || envValue === "verbatim") return {
		value: envValue,
		source: `env:${TELEGRAM_DNS_RESULT_ORDER_ENV}`
	};
	const configValue = (params?.network)?.dnsResultOrder?.trim().toLowerCase();
	if (configValue === "ipv4first" || configValue === "verbatim") return {
		value: configValue,
		source: "config"
	};
	if (Number.isFinite(nodeMajor) && nodeMajor >= 22) return {
		value: "ipv4first",
		source: "default-node22"
	};
	return { value: null };
}

//#endregion
//#region src/telegram/fetch.ts
let appliedAutoSelectFamily = null;
let appliedDnsResultOrder = null;
let appliedGlobalDispatcherAutoSelectFamily = null;
const log = createSubsystemLogger("telegram/network");
function applyTelegramNetworkWorkarounds(network) {
	const autoSelectDecision = resolveTelegramAutoSelectFamilyDecision({ network });
	if (autoSelectDecision.value !== null && autoSelectDecision.value !== appliedAutoSelectFamily) {
		if (typeof net$1.setDefaultAutoSelectFamily === "function") try {
			net$1.setDefaultAutoSelectFamily(autoSelectDecision.value);
			appliedAutoSelectFamily = autoSelectDecision.value;
			const label = autoSelectDecision.source ? ` (${autoSelectDecision.source})` : "";
			log.info(`autoSelectFamily=${autoSelectDecision.value}${label}`);
		} catch {}
	}
	if (autoSelectDecision.value !== null && autoSelectDecision.value !== appliedGlobalDispatcherAutoSelectFamily) try {
		setGlobalDispatcher(new Agent({ connect: {
			autoSelectFamily: autoSelectDecision.value,
			autoSelectFamilyAttemptTimeout: 300
		} }));
		appliedGlobalDispatcherAutoSelectFamily = autoSelectDecision.value;
		log.info(`global undici dispatcher autoSelectFamily=${autoSelectDecision.value}`);
	} catch {}
	const dnsDecision = resolveTelegramDnsResultOrderDecision({ network });
	if (dnsDecision.value !== null && dnsDecision.value !== appliedDnsResultOrder) {
		if (typeof dns.setDefaultResultOrder === "function") try {
			dns.setDefaultResultOrder(dnsDecision.value);
			appliedDnsResultOrder = dnsDecision.value;
			const label = dnsDecision.source ? ` (${dnsDecision.source})` : "";
			log.info(`dnsResultOrder=${dnsDecision.value}${label}`);
		} catch {}
	}
}
function resolveTelegramFetch(proxyFetch, options) {
	applyTelegramNetworkWorkarounds(options?.network);
	if (proxyFetch) return resolveFetch(proxyFetch);
	const fetchImpl = resolveFetch();
	if (!fetchImpl) throw new Error("fetch is not available; set channels.telegram.proxy in config");
	return fetchImpl;
}

//#endregion
//#region src/telegram/format.ts
function escapeHtml(text) {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeHtmlAttr(text) {
	return escapeHtml(text).replace(/"/g, "&quot;");
}
/**
* File extensions that share TLDs and commonly appear in code/documentation.
* These are wrapped in <code> tags to prevent Telegram from generating
* spurious domain registrar previews.
*
* Only includes extensions that are:
* 1. Commonly used as file extensions in code/docs
* 2. Rarely used as intentional domain references
*
* Excluded: .ai, .io, .tv, .fm (popular domain TLDs like x.ai, vercel.io, github.io)
*/
const FILE_EXTENSIONS_WITH_TLD = new Set([
	"md",
	"go",
	"py",
	"pl",
	"sh",
	"am",
	"at",
	"be",
	"cc"
]);
/** Detects when markdown-it linkify auto-generated a link from a bare filename (e.g. README.md → http://README.md) */
function isAutoLinkedFileRef(href, label) {
	if (href.replace(/^https?:\/\//i, "") !== label) return false;
	const dotIndex = label.lastIndexOf(".");
	if (dotIndex < 1) return false;
	const ext = label.slice(dotIndex + 1).toLowerCase();
	if (!FILE_EXTENSIONS_WITH_TLD.has(ext)) return false;
	const segments = label.split("/");
	if (segments.length > 1) {
		for (let i = 0; i < segments.length - 1; i++) if (segments[i].includes(".")) return false;
	}
	return true;
}
function buildTelegramLink(link, text) {
	const href = link.href.trim();
	if (!href) return null;
	if (link.start === link.end) return null;
	if (isAutoLinkedFileRef(href, text.slice(link.start, link.end))) return null;
	const safeHref = escapeHtmlAttr(href);
	return {
		start: link.start,
		end: link.end,
		open: `<a href="${safeHref}">`,
		close: "</a>"
	};
}
function renderTelegramHtml(ir) {
	return renderMarkdownWithMarkers(ir, {
		styleMarkers: {
			bold: {
				open: "<b>",
				close: "</b>"
			},
			italic: {
				open: "<i>",
				close: "</i>"
			},
			strikethrough: {
				open: "<s>",
				close: "</s>"
			},
			code: {
				open: "<code>",
				close: "</code>"
			},
			code_block: {
				open: "<pre><code>",
				close: "</code></pre>"
			},
			spoiler: {
				open: "<tg-spoiler>",
				close: "</tg-spoiler>"
			},
			blockquote: {
				open: "<blockquote>",
				close: "</blockquote>"
			}
		},
		escapeText: escapeHtml,
		buildLink: buildTelegramLink
	});
}
function markdownToTelegramHtml(markdown, options = {}) {
	const html = renderTelegramHtml(markdownToIR(markdown ?? "", {
		linkify: true,
		enableSpoilers: true,
		headingStyle: "none",
		blockquotePrefix: "",
		tableMode: options.tableMode
	}));
	if (options.wrapFileRefs !== false) return wrapFileReferencesInHtml(html);
	return html;
}
/**
* Wraps standalone file references (with TLD extensions) in <code> tags.
* This prevents Telegram from treating them as URLs and generating
* irrelevant domain registrar previews.
*
* Runs AFTER markdown→HTML conversion to avoid modifying HTML attributes.
* Skips content inside <code>, <pre>, and <a> tags to avoid nesting issues.
*/
/** Escape regex metacharacters in a string */
function escapeRegex(str) {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
const FILE_EXTENSIONS_PATTERN = Array.from(FILE_EXTENSIONS_WITH_TLD).map(escapeRegex).join("|");
const AUTO_LINKED_ANCHOR_PATTERN = /<a\s+href="https?:\/\/([^"]+)"[^>]*>\1<\/a>/gi;
const FILE_REFERENCE_PATTERN = new RegExp(`(^|[^a-zA-Z0-9_\\-/])([a-zA-Z0-9_.\\-./]+\\.(?:${FILE_EXTENSIONS_PATTERN}))(?=$|[^a-zA-Z0-9_\\-/])`, "gi");
const ORPHANED_TLD_PATTERN = new RegExp(`([^a-zA-Z0-9]|^)([A-Za-z]\\.(?:${FILE_EXTENSIONS_PATTERN}))(?=[^a-zA-Z0-9/]|$)`, "g");
const HTML_TAG_PATTERN = /(<\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?>/gi;
function wrapStandaloneFileRef(match, prefix, filename) {
	if (filename.startsWith("//")) return match;
	if (/https?:\/\/$/i.test(prefix)) return match;
	return `${prefix}<code>${escapeHtml(filename)}</code>`;
}
function wrapSegmentFileRefs(text, codeDepth, preDepth, anchorDepth) {
	if (!text || codeDepth > 0 || preDepth > 0 || anchorDepth > 0) return text;
	return text.replace(FILE_REFERENCE_PATTERN, wrapStandaloneFileRef).replace(ORPHANED_TLD_PATTERN, (match, prefix, tld) => prefix === ">" ? match : `${prefix}<code>${escapeHtml(tld)}</code>`);
}
function wrapFileReferencesInHtml(html) {
	AUTO_LINKED_ANCHOR_PATTERN.lastIndex = 0;
	const deLinkified = html.replace(AUTO_LINKED_ANCHOR_PATTERN, (_match, label) => {
		if (!isAutoLinkedFileRef(`http://${label}`, label)) return _match;
		return `<code>${escapeHtml(label)}</code>`;
	});
	let codeDepth = 0;
	let preDepth = 0;
	let anchorDepth = 0;
	let result = "";
	let lastIndex = 0;
	HTML_TAG_PATTERN.lastIndex = 0;
	let match;
	while ((match = HTML_TAG_PATTERN.exec(deLinkified)) !== null) {
		const tagStart = match.index;
		const tagEnd = HTML_TAG_PATTERN.lastIndex;
		const isClosing = match[1] === "</";
		const tagName = match[2].toLowerCase();
		const textBefore = deLinkified.slice(lastIndex, tagStart);
		result += wrapSegmentFileRefs(textBefore, codeDepth, preDepth, anchorDepth);
		if (tagName === "code") codeDepth = isClosing ? Math.max(0, codeDepth - 1) : codeDepth + 1;
		else if (tagName === "pre") preDepth = isClosing ? Math.max(0, preDepth - 1) : preDepth + 1;
		else if (tagName === "a") anchorDepth = isClosing ? Math.max(0, anchorDepth - 1) : anchorDepth + 1;
		result += deLinkified.slice(tagStart, tagEnd);
		lastIndex = tagEnd;
	}
	const remainingText = deLinkified.slice(lastIndex);
	result += wrapSegmentFileRefs(remainingText, codeDepth, preDepth, anchorDepth);
	return result;
}
function renderTelegramHtmlText(text, options = {}) {
	if ((options.textMode ?? "markdown") === "html") return text;
	return markdownToTelegramHtml(text, { tableMode: options.tableMode });
}
function splitTelegramChunkByHtmlLimit(chunk, htmlLimit, renderedHtmlLength) {
	const currentTextLength = chunk.text.length;
	if (currentTextLength <= 1) return [chunk];
	const proportionalLimit = Math.floor(currentTextLength * htmlLimit / Math.max(renderedHtmlLength, 1));
	const candidateLimit = Math.min(currentTextLength - 1, proportionalLimit);
	const split = splitMarkdownIRPreserveWhitespace(chunk, Number.isFinite(candidateLimit) && candidateLimit > 0 ? candidateLimit : Math.max(1, Math.floor(currentTextLength / 2)));
	if (split.length > 1) return split;
	return splitMarkdownIRPreserveWhitespace(chunk, Math.max(1, Math.floor(currentTextLength / 2)));
}
function sliceStyleSpans(styles, start, end) {
	return styles.flatMap((span) => {
		if (span.end <= start || span.start >= end) return [];
		const nextStart = Math.max(span.start, start) - start;
		const nextEnd = Math.min(span.end, end) - start;
		if (nextEnd <= nextStart) return [];
		return [{
			...span,
			start: nextStart,
			end: nextEnd
		}];
	});
}
function sliceLinkSpans(links, start, end) {
	return links.flatMap((link) => {
		if (link.end <= start || link.start >= end) return [];
		const nextStart = Math.max(link.start, start) - start;
		const nextEnd = Math.min(link.end, end) - start;
		if (nextEnd <= nextStart) return [];
		return [{
			...link,
			start: nextStart,
			end: nextEnd
		}];
	});
}
function splitMarkdownIRPreserveWhitespace(ir, limit) {
	if (!ir.text) return [];
	const normalizedLimit = Math.max(1, Math.floor(limit));
	if (normalizedLimit <= 0 || ir.text.length <= normalizedLimit) return [ir];
	const chunks = [];
	let cursor = 0;
	while (cursor < ir.text.length) {
		const end = Math.min(ir.text.length, cursor + normalizedLimit);
		chunks.push({
			text: ir.text.slice(cursor, end),
			styles: sliceStyleSpans(ir.styles, cursor, end),
			links: sliceLinkSpans(ir.links, cursor, end)
		});
		cursor = end;
	}
	return chunks;
}
function renderTelegramChunksWithinHtmlLimit(ir, limit) {
	const normalizedLimit = Math.max(1, Math.floor(limit));
	const pending = chunkMarkdownIR(ir, normalizedLimit);
	const rendered = [];
	while (pending.length > 0) {
		const chunk = pending.shift();
		if (!chunk) continue;
		const html = wrapFileReferencesInHtml(renderTelegramHtml(chunk));
		if (html.length <= normalizedLimit || chunk.text.length <= 1) {
			rendered.push({
				html,
				text: chunk.text
			});
			continue;
		}
		const split = splitTelegramChunkByHtmlLimit(chunk, normalizedLimit, html.length);
		if (split.length <= 1) {
			rendered.push({
				html,
				text: chunk.text
			});
			continue;
		}
		pending.unshift(...split);
	}
	return rendered;
}
function markdownToTelegramChunks(markdown, limit, options = {}) {
	return renderTelegramChunksWithinHtmlLimit(markdownToIR(markdown ?? "", {
		linkify: true,
		enableSpoilers: true,
		headingStyle: "none",
		blockquotePrefix: "",
		tableMode: options.tableMode
	}), limit);
}

//#endregion
//#region src/telegram/network-errors.ts
const RECOVERABLE_ERROR_CODES = new Set([
	"ECONNRESET",
	"ECONNREFUSED",
	"EPIPE",
	"ETIMEDOUT",
	"ESOCKETTIMEDOUT",
	"ENETUNREACH",
	"EHOSTUNREACH",
	"ENOTFOUND",
	"EAI_AGAIN",
	"UND_ERR_CONNECT_TIMEOUT",
	"UND_ERR_HEADERS_TIMEOUT",
	"UND_ERR_BODY_TIMEOUT",
	"UND_ERR_SOCKET",
	"UND_ERR_ABORTED",
	"ECONNABORTED",
	"ERR_NETWORK"
]);
const RECOVERABLE_ERROR_NAMES = new Set([
	"AbortError",
	"TimeoutError",
	"ConnectTimeoutError",
	"HeadersTimeoutError",
	"BodyTimeoutError"
]);
const ALWAYS_RECOVERABLE_MESSAGES = new Set(["fetch failed", "typeerror: fetch failed"]);
const RECOVERABLE_MESSAGE_SNIPPETS = [
	"undici",
	"network error",
	"network request",
	"client network socket disconnected",
	"socket hang up",
	"getaddrinfo",
	"timeout",
	"timed out"
];
function normalizeCode(code) {
	return code?.trim().toUpperCase() ?? "";
}
function getErrorName(err) {
	if (!err || typeof err !== "object") return "";
	return "name" in err ? String(err.name) : "";
}
function getErrorCode(err) {
	const direct = extractErrorCode(err);
	if (direct) return direct;
	if (!err || typeof err !== "object") return;
	const errno = err.errno;
	if (typeof errno === "string") return errno;
	if (typeof errno === "number") return String(errno);
}
function collectErrorCandidates(err) {
	const queue = [err];
	const seen = /* @__PURE__ */ new Set();
	const candidates = [];
	while (queue.length > 0) {
		const current = queue.shift();
		if (current == null || seen.has(current)) continue;
		seen.add(current);
		candidates.push(current);
		if (typeof current === "object") {
			const cause = current.cause;
			if (cause && !seen.has(cause)) queue.push(cause);
			const reason = current.reason;
			if (reason && !seen.has(reason)) queue.push(reason);
			const errors = current.errors;
			if (Array.isArray(errors)) {
				for (const nested of errors) if (nested && !seen.has(nested)) queue.push(nested);
			}
			if (getErrorName(current) === "HttpError") {
				const wrappedError = current.error;
				if (wrappedError && !seen.has(wrappedError)) queue.push(wrappedError);
			}
		}
	}
	return candidates;
}
function isRecoverableTelegramNetworkError(err, options = {}) {
	if (!err) return false;
	const allowMessageMatch = typeof options.allowMessageMatch === "boolean" ? options.allowMessageMatch : options.context !== "send";
	for (const candidate of collectErrorCandidates(err)) {
		const code = normalizeCode(getErrorCode(candidate));
		if (code && RECOVERABLE_ERROR_CODES.has(code)) return true;
		const name = getErrorName(candidate);
		if (name && RECOVERABLE_ERROR_NAMES.has(name)) return true;
		const message = formatErrorMessage(candidate).trim().toLowerCase();
		if (message && ALWAYS_RECOVERABLE_MESSAGES.has(message)) return true;
		if (allowMessageMatch && message) {
			if (RECOVERABLE_MESSAGE_SNIPPETS.some((snippet) => message.includes(snippet))) return true;
		}
	}
	return false;
}

//#endregion
//#region src/telegram/sent-message-cache.ts
/**
* In-memory cache of sent message IDs per chat.
* Used to identify bot's own messages for reaction filtering ("own" mode).
*/
const TTL_MS = 1440 * 60 * 1e3;
const sentMessages = /* @__PURE__ */ new Map();
function getChatKey(chatId) {
	return String(chatId);
}
function cleanupExpired(entry) {
	const now = Date.now();
	for (const [msgId, timestamp] of entry.timestamps) if (now - timestamp > TTL_MS) entry.timestamps.delete(msgId);
}
/**
* Record a message ID as sent by the bot.
*/
function recordSentMessage(chatId, messageId) {
	const key = getChatKey(chatId);
	let entry = sentMessages.get(key);
	if (!entry) {
		entry = { timestamps: /* @__PURE__ */ new Map() };
		sentMessages.set(key, entry);
	}
	entry.timestamps.set(messageId, Date.now());
	if (entry.timestamps.size > 100) cleanupExpired(entry);
}
/**
* Check if a message was sent by the bot.
*/
function wasSentByBot(chatId, messageId) {
	const key = getChatKey(chatId);
	const entry = sentMessages.get(key);
	if (!entry) return false;
	cleanupExpired(entry);
	return entry.timestamps.has(messageId);
}

//#endregion
//#region src/cron/store.ts
const DEFAULT_CRON_DIR = path.join(CONFIG_DIR, "cron");
const DEFAULT_CRON_STORE_PATH = path.join(DEFAULT_CRON_DIR, "jobs.json");
function resolveCronStorePath(storePath) {
	if (storePath?.trim()) {
		const raw = storePath.trim();
		if (raw.startsWith("~")) return path.resolve(expandHomePrefix(raw));
		return path.resolve(raw);
	}
	return DEFAULT_CRON_STORE_PATH;
}
async function loadCronStore(storePath) {
	try {
		const raw = await fs.promises.readFile(storePath, "utf-8");
		let parsed;
		try {
			parsed = json5.parse(raw);
		} catch (err) {
			throw new Error(`Failed to parse cron store at ${storePath}: ${String(err)}`, { cause: err });
		}
		const parsedRecord = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
		return {
			version: 1,
			jobs: (Array.isArray(parsedRecord.jobs) ? parsedRecord.jobs : []).filter(Boolean)
		};
	} catch (err) {
		if (err?.code === "ENOENT") return {
			version: 1,
			jobs: []
		};
		throw err;
	}
}
async function saveCronStore(storePath, store) {
	await fs.promises.mkdir(path.dirname(storePath), { recursive: true });
	const { randomBytes } = await import("node:crypto");
	const json = JSON.stringify(store, null, 2);
	let previous = null;
	try {
		previous = await fs.promises.readFile(storePath, "utf-8");
	} catch (err) {
		if (err.code !== "ENOENT") throw err;
	}
	if (previous === json) return;
	const tmp = `${storePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
	await fs.promises.writeFile(tmp, json, "utf-8");
	if (previous !== null) try {
		await fs.promises.copyFile(storePath, `${storePath}.bak`);
	} catch {}
	await fs.promises.rename(tmp, storePath);
}

//#endregion
//#region src/telegram/target-writeback.ts
const writebackLogger = createSubsystemLogger("telegram/target-writeback");
function asObjectRecord(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return value;
}
function normalizeTelegramLookupTargetForMatch(raw) {
	const normalized = normalizeTelegramLookupTarget(raw);
	if (!normalized) return;
	return normalized.startsWith("@") ? normalized.toLowerCase() : normalized;
}
function normalizeTelegramTargetForMatch(raw) {
	const parsed = parseTelegramTarget(raw);
	const normalized = normalizeTelegramLookupTargetForMatch(parsed.chatId);
	if (!normalized) return;
	return `${normalized}|${parsed.messageThreadId == null ? "" : String(parsed.messageThreadId)}`;
}
function buildResolvedTelegramTarget(params) {
	const { raw, parsed, resolvedChatId } = params;
	if (parsed.messageThreadId == null) return resolvedChatId;
	return raw.includes(":topic:") ? `${resolvedChatId}:topic:${parsed.messageThreadId}` : `${resolvedChatId}:${parsed.messageThreadId}`;
}
function resolveLegacyRewrite(params) {
	const parsed = parseTelegramTarget(params.raw);
	if (normalizeTelegramChatId(parsed.chatId)) return null;
	const normalized = normalizeTelegramLookupTargetForMatch(parsed.chatId);
	if (!normalized) return null;
	return {
		matchKey: `${normalized}|${parsed.messageThreadId == null ? "" : String(parsed.messageThreadId)}`,
		resolvedTarget: buildResolvedTelegramTarget({
			raw: params.raw,
			parsed,
			resolvedChatId: params.resolvedChatId
		})
	};
}
function rewriteTargetIfMatch(params) {
	if (typeof params.rawValue !== "string" && typeof params.rawValue !== "number") return null;
	const value = String(params.rawValue).trim();
	if (!value) return null;
	if (normalizeTelegramTargetForMatch(value) !== params.matchKey) return null;
	return params.resolvedTarget;
}
function replaceTelegramDefaultToTargets(params) {
	let changed = false;
	const telegram = asObjectRecord(params.cfg.channels?.telegram);
	if (!telegram) return changed;
	const maybeReplace = (holder, key) => {
		const nextTarget = rewriteTargetIfMatch({
			rawValue: holder[key],
			matchKey: params.matchKey,
			resolvedTarget: params.resolvedTarget
		});
		if (!nextTarget) return;
		holder[key] = nextTarget;
		changed = true;
	};
	maybeReplace(telegram, "defaultTo");
	const accounts = asObjectRecord(telegram.accounts);
	if (!accounts) return changed;
	for (const accountId of Object.keys(accounts)) {
		const account = asObjectRecord(accounts[accountId]);
		if (!account) continue;
		maybeReplace(account, "defaultTo");
	}
	return changed;
}
async function maybePersistResolvedTelegramTarget(params) {
	const raw = params.rawTarget.trim();
	if (!raw) return;
	const rewrite = resolveLegacyRewrite({
		raw,
		resolvedChatId: params.resolvedChatId
	});
	if (!rewrite) return;
	const { matchKey, resolvedTarget } = rewrite;
	try {
		const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
		const nextConfig = structuredClone(snapshot.config ?? {});
		if (replaceTelegramDefaultToTargets({
			cfg: nextConfig,
			matchKey,
			resolvedTarget
		})) {
			await writeConfigFile(nextConfig, writeOptions);
			if (params.verbose) writebackLogger.warn(`resolved Telegram defaultTo target ${raw} -> ${resolvedTarget}`);
		}
	} catch (err) {
		if (params.verbose) writebackLogger.warn(`failed to persist Telegram defaultTo target ${raw}: ${String(err)}`);
	}
	try {
		const storePath = resolveCronStorePath(params.cfg.cron?.store);
		const store = await loadCronStore(storePath);
		let cronChanged = false;
		for (const job of store.jobs) {
			if (job.delivery?.channel !== "telegram") continue;
			const nextTarget = rewriteTargetIfMatch({
				rawValue: job.delivery.to,
				matchKey,
				resolvedTarget
			});
			if (!nextTarget) continue;
			job.delivery.to = nextTarget;
			cronChanged = true;
		}
		if (cronChanged) {
			await saveCronStore(storePath, store);
			if (params.verbose) writebackLogger.warn(`resolved Telegram cron delivery target ${raw} -> ${resolvedTarget}`);
		}
	} catch (err) {
		if (params.verbose) writebackLogger.warn(`failed to persist Telegram cron target ${raw}: ${String(err)}`);
	}
}

//#endregion
//#region src/telegram/voice.ts
function resolveTelegramVoiceDecision(opts) {
	if (!opts.wantsVoice) return { useVoice: false };
	if (isTelegramVoiceCompatibleAudio(opts)) return { useVoice: true };
	return {
		useVoice: false,
		reason: `media is ${opts.contentType ?? "unknown"} (${opts.fileName ?? "unknown"})`
	};
}
function resolveTelegramVoiceSend(opts) {
	const decision = resolveTelegramVoiceDecision(opts);
	if (decision.reason && opts.logFallback) opts.logFallback(`Telegram voice requested but ${decision.reason}; sending as audio file instead.`);
	return { useVoice: decision.useVoice };
}

//#endregion
//#region src/telegram/send.ts
var send_exports = /* @__PURE__ */ __exportAll({
	buildInlineKeyboard: () => buildInlineKeyboard,
	createForumTopicTelegram: () => createForumTopicTelegram,
	deleteMessageTelegram: () => deleteMessageTelegram,
	editMessageTelegram: () => editMessageTelegram,
	reactMessageTelegram: () => reactMessageTelegram,
	sendMessageTelegram: () => sendMessageTelegram,
	sendPollTelegram: () => sendPollTelegram,
	sendStickerTelegram: () => sendStickerTelegram
});
function resolveTelegramMessageIdOrThrow(result, context) {
	if (typeof result?.message_id === "number" && Number.isFinite(result.message_id)) return Math.trunc(result.message_id);
	throw new Error(`Telegram ${context} returned no message_id`);
}
const PARSE_ERR_RE = /can't parse entities|parse entities|find end of the entity/i;
const THREAD_NOT_FOUND_RE = /400:\s*Bad Request:\s*message thread not found/i;
const MESSAGE_NOT_MODIFIED_RE = /400:\s*Bad Request:\s*message is not modified|MESSAGE_NOT_MODIFIED/i;
const CHAT_NOT_FOUND_RE = /400: Bad Request: chat not found/i;
const sendLogger = createSubsystemLogger("telegram/send");
const diagLogger = createSubsystemLogger("telegram/diagnostic");
function createTelegramHttpLogger(cfg) {
	if (!isDiagnosticFlagEnabled("telegram.http", cfg)) return () => {};
	return (label, err) => {
		if (!(err instanceof HttpError)) return;
		const detail = redactSensitiveText(formatUncaughtError(err.error ?? err));
		diagLogger.warn(`telegram http error (${label}): ${detail}`);
	};
}
function resolveTelegramClientOptions(account) {
	const proxyUrl = account.config.proxy?.trim();
	const fetchImpl = resolveTelegramFetch(proxyUrl ? makeProxyFetch(proxyUrl) : void 0, { network: account.config.network });
	const timeoutSeconds = typeof account.config.timeoutSeconds === "number" && Number.isFinite(account.config.timeoutSeconds) ? Math.max(1, Math.floor(account.config.timeoutSeconds)) : void 0;
	return fetchImpl || timeoutSeconds ? {
		...fetchImpl ? { fetch: fetchImpl } : {},
		...timeoutSeconds ? { timeoutSeconds } : {}
	} : void 0;
}
function resolveToken(explicit, params) {
	if (explicit?.trim()) return explicit.trim();
	if (!params.token) throw new Error(`Telegram bot token missing for account "${params.accountId}" (set channels.telegram.accounts.${params.accountId}.botToken/tokenFile or TELEGRAM_BOT_TOKEN for default).`);
	return params.token.trim();
}
async function resolveChatId(to, params) {
	const numericChatId = normalizeTelegramChatId(to);
	if (numericChatId) return numericChatId;
	const lookupTarget = normalizeTelegramLookupTarget(to);
	const getChat = params.api.getChat;
	if (!lookupTarget || typeof getChat !== "function") throw new Error("Telegram recipient must be a numeric chat ID");
	try {
		const chat = await getChat.call(params.api, lookupTarget);
		const resolved = normalizeTelegramChatId(String(chat?.id ?? ""));
		if (!resolved) throw new Error(`resolved chat id is not numeric (${String(chat?.id ?? "")})`);
		if (params.verbose) sendLogger.warn(`telegram recipient ${lookupTarget} resolved to numeric chat id ${resolved}`);
		return resolved;
	} catch (err) {
		const detail = formatErrorMessage(err);
		throw new Error(`Telegram recipient ${lookupTarget} could not be resolved to a numeric chat ID (${detail})`, { cause: err });
	}
}
async function resolveAndPersistChatId(params) {
	const chatId = await resolveChatId(params.lookupTarget, {
		api: params.api,
		verbose: params.verbose
	});
	await maybePersistResolvedTelegramTarget({
		cfg: params.cfg,
		rawTarget: params.persistTarget,
		resolvedChatId: chatId,
		verbose: params.verbose
	});
	return chatId;
}
function normalizeMessageId(raw) {
	if (typeof raw === "number" && Number.isFinite(raw)) return Math.trunc(raw);
	if (typeof raw === "string") {
		const value = raw.trim();
		if (!value) throw new Error("Message id is required for Telegram actions");
		const parsed = Number.parseInt(value, 10);
		if (Number.isFinite(parsed)) return parsed;
	}
	throw new Error("Message id is required for Telegram actions");
}
function isTelegramThreadNotFoundError(err) {
	return THREAD_NOT_FOUND_RE.test(formatErrorMessage(err));
}
function isTelegramMessageNotModifiedError(err) {
	return MESSAGE_NOT_MODIFIED_RE.test(formatErrorMessage(err));
}
function hasMessageThreadIdParam(params) {
	if (!params) return false;
	const value = params.message_thread_id;
	if (typeof value === "number") return Number.isFinite(value);
	if (typeof value === "string") return value.trim().length > 0;
	return false;
}
function removeMessageThreadIdParam(params) {
	if (!params || !hasMessageThreadIdParam(params)) return params;
	const next = { ...params };
	delete next.message_thread_id;
	return Object.keys(next).length > 0 ? next : void 0;
}
function isTelegramHtmlParseError(err) {
	return PARSE_ERR_RE.test(formatErrorMessage(err));
}
function buildTelegramThreadReplyParams(params) {
	const messageThreadId = params.messageThreadId != null ? params.messageThreadId : params.targetMessageThreadId;
	const threadScope = params.chatType === "direct" ? "dm" : "forum";
	const threadIdParams = buildTelegramThreadParams(messageThreadId != null ? {
		id: messageThreadId,
		scope: threadScope
	} : void 0);
	const threadParams = threadIdParams ? { ...threadIdParams } : {};
	if (params.replyToMessageId != null) {
		const replyToMessageId = Math.trunc(params.replyToMessageId);
		if (params.quoteText?.trim()) threadParams.reply_parameters = {
			message_id: replyToMessageId,
			quote: params.quoteText.trim()
		};
		else threadParams.reply_to_message_id = replyToMessageId;
	}
	return threadParams;
}
async function withTelegramHtmlParseFallback(params) {
	try {
		return await params.requestHtml(params.label);
	} catch (err) {
		if (!isTelegramHtmlParseError(err)) throw err;
		if (params.verbose) sendLogger.warn(`telegram ${params.label} failed with HTML parse error, retrying as plain text: ${formatErrorMessage(err)}`);
		return await params.requestPlain(`${params.label}-plain`);
	}
}
function resolveTelegramApiContext(opts) {
	const cfg = opts.cfg ?? loadConfig();
	const account = resolveTelegramAccount({
		cfg,
		accountId: opts.accountId
	});
	const token = resolveToken(opts.token, account);
	const client = resolveTelegramClientOptions(account);
	return {
		cfg,
		account,
		api: opts.api ?? new Bot(token, client ? { client } : void 0).api
	};
}
function createTelegramRequestWithDiag(params) {
	const request = createTelegramRetryRunner({
		retry: params.retry,
		configRetry: params.account.config.retry,
		verbose: params.verbose,
		...params.shouldRetry ? { shouldRetry: params.shouldRetry } : {}
	});
	const logHttpError = createTelegramHttpLogger(params.cfg);
	return (fn, label, options) => {
		const runRequest = () => request(fn, label);
		return (params.useApiErrorLogging === false ? runRequest() : withTelegramApiErrorLogging({
			operation: label ?? "request",
			fn: runRequest,
			...options?.shouldLog ? { shouldLog: options.shouldLog } : {}
		})).catch((err) => {
			logHttpError(label ?? "request", err);
			throw err;
		});
	};
}
function wrapTelegramChatNotFoundError(err, params) {
	if (!CHAT_NOT_FOUND_RE.test(formatErrorMessage(err))) return err;
	return new Error([
		`Telegram send failed: chat not found (chat_id=${params.chatId}).`,
		"Likely: bot not started in DM, bot removed from group/channel, group migrated (new -100… id), or wrong bot token.",
		`Input was: ${JSON.stringify(params.input)}.`
	].join(" "));
}
async function withTelegramThreadFallback(params, label, verbose, attempt) {
	try {
		return await attempt(params, label);
	} catch (err) {
		if (!hasMessageThreadIdParam(params) || !isTelegramThreadNotFoundError(err)) throw err;
		if (verbose) sendLogger.warn(`telegram ${label} failed with message_thread_id, retrying without thread: ${formatErrorMessage(err)}`);
		return await attempt(removeMessageThreadIdParam(params), `${label}-threadless`);
	}
}
function createRequestWithChatNotFound(params) {
	return async (fn, label) => params.requestWithDiag(fn, label).catch((err) => {
		throw wrapTelegramChatNotFoundError(err, {
			chatId: params.chatId,
			input: params.input
		});
	});
}
function buildInlineKeyboard(buttons) {
	if (!buttons?.length) return;
	const rows = buttons.map((row) => row.filter((button) => button?.text && button?.callback_data).map((button) => ({
		text: button.text,
		callback_data: button.callback_data,
		...button.style ? { style: button.style } : {}
	}))).filter((row) => row.length > 0);
	if (rows.length === 0) return;
	return { inline_keyboard: rows };
}
async function sendMessageTelegram(to, text, opts = {}) {
	const { cfg, account, api } = resolveTelegramApiContext(opts);
	const target = parseTelegramTarget(to);
	const chatId = await resolveAndPersistChatId({
		cfg,
		api,
		lookupTarget: target.chatId,
		persistTarget: to,
		verbose: opts.verbose
	});
	const mediaUrl = opts.mediaUrl?.trim();
	const replyMarkup = buildInlineKeyboard(opts.buttons);
	const threadParams = buildTelegramThreadReplyParams({
		targetMessageThreadId: target.messageThreadId,
		messageThreadId: opts.messageThreadId,
		chatType: target.chatType,
		replyToMessageId: opts.replyToMessageId,
		quoteText: opts.quoteText
	});
	const hasThreadParams = Object.keys(threadParams).length > 0;
	const requestWithChatNotFound = createRequestWithChatNotFound({
		requestWithDiag: createTelegramRequestWithDiag({
			cfg,
			account,
			retry: opts.retry,
			verbose: opts.verbose,
			shouldRetry: (err) => isRecoverableTelegramNetworkError(err, { context: "send" })
		}),
		chatId,
		input: to
	});
	const textMode = opts.textMode ?? "markdown";
	const tableMode = resolveMarkdownTableMode({
		cfg,
		channel: "telegram",
		accountId: account.accountId
	});
	const renderHtmlText = (value) => renderTelegramHtmlText(value, {
		textMode,
		tableMode
	});
	const linkPreviewOptions = account.config.linkPreview ?? true ? void 0 : { is_disabled: true };
	const sendTelegramText = async (rawText, params, fallbackText) => {
		return await withTelegramThreadFallback(params, "message", opts.verbose, async (effectiveParams, label) => {
			const htmlText = renderHtmlText(rawText);
			const baseParams = effectiveParams ? { ...effectiveParams } : {};
			if (linkPreviewOptions) baseParams.link_preview_options = linkPreviewOptions;
			const hasBaseParams = Object.keys(baseParams).length > 0;
			const sendParams = {
				parse_mode: "HTML",
				...baseParams,
				...opts.silent === true ? { disable_notification: true } : {}
			};
			return await withTelegramHtmlParseFallback({
				label,
				verbose: opts.verbose,
				requestHtml: (retryLabel) => requestWithChatNotFound(() => api.sendMessage(chatId, htmlText, sendParams), retryLabel),
				requestPlain: (retryLabel) => {
					const plainParams = hasBaseParams ? baseParams : void 0;
					return requestWithChatNotFound(() => plainParams ? api.sendMessage(chatId, fallbackText ?? rawText, plainParams) : api.sendMessage(chatId, fallbackText ?? rawText), retryLabel);
				}
			});
		});
	};
	if (mediaUrl) {
		const media = await loadWebMedia(mediaUrl, {
			maxBytes: opts.maxBytes,
			localRoots: opts.mediaLocalRoots
		});
		const kind = mediaKindFromMime(media.contentType ?? void 0);
		const isGif = isGifMedia({
			contentType: media.contentType,
			fileName: media.fileName
		});
		const isVideoNote = kind === "video" && opts.asVideoNote === true;
		const fileName = media.fileName ?? (isGif ? "animation.gif" : inferFilename(kind)) ?? "file";
		const file = new InputFile(media.buffer, fileName);
		let caption;
		let followUpText;
		if (isVideoNote) {
			caption = void 0;
			followUpText = text.trim() ? text : void 0;
		} else {
			const split = splitTelegramCaption(text);
			caption = split.caption;
			followUpText = split.followUpText;
		}
		const htmlCaption = caption ? renderHtmlText(caption) : void 0;
		const needsSeparateText = Boolean(followUpText);
		const baseMediaParams = {
			...hasThreadParams ? threadParams : {},
			...!needsSeparateText && replyMarkup ? { reply_markup: replyMarkup } : {}
		};
		const mediaParams = {
			...htmlCaption ? {
				caption: htmlCaption,
				parse_mode: "HTML"
			} : {},
			...baseMediaParams,
			...opts.silent === true ? { disable_notification: true } : {}
		};
		const sendMedia = async (label, sender) => await withTelegramThreadFallback(mediaParams, label, opts.verbose, async (effectiveParams, retryLabel) => requestWithChatNotFound(() => sender(effectiveParams), retryLabel));
		const mediaSender = (() => {
			if (isGif) return {
				label: "animation",
				sender: (effectiveParams) => api.sendAnimation(chatId, file, effectiveParams)
			};
			if (kind === "image") return {
				label: "photo",
				sender: (effectiveParams) => api.sendPhoto(chatId, file, effectiveParams)
			};
			if (kind === "video") {
				if (isVideoNote) return {
					label: "video_note",
					sender: (effectiveParams) => api.sendVideoNote(chatId, file, effectiveParams)
				};
				return {
					label: "video",
					sender: (effectiveParams) => api.sendVideo(chatId, file, effectiveParams)
				};
			}
			if (kind === "audio") {
				const { useVoice } = resolveTelegramVoiceSend({
					wantsVoice: opts.asVoice === true,
					contentType: media.contentType,
					fileName,
					logFallback: logVerbose
				});
				if (useVoice) return {
					label: "voice",
					sender: (effectiveParams) => api.sendVoice(chatId, file, effectiveParams)
				};
				return {
					label: "audio",
					sender: (effectiveParams) => api.sendAudio(chatId, file, effectiveParams)
				};
			}
			return {
				label: "document",
				sender: (effectiveParams) => api.sendDocument(chatId, file, effectiveParams)
			};
		})();
		const result = await sendMedia(mediaSender.label, mediaSender.sender);
		const mediaMessageId = resolveTelegramMessageIdOrThrow(result, "media send");
		const resolvedChatId = String(result?.chat?.id ?? chatId);
		recordSentMessage(chatId, mediaMessageId);
		recordChannelActivity({
			channel: "telegram",
			accountId: account.accountId,
			direction: "outbound"
		});
		if (needsSeparateText && followUpText) {
			const textParams = hasThreadParams || replyMarkup ? {
				...threadParams,
				...replyMarkup ? { reply_markup: replyMarkup } : {}
			} : void 0;
			const textMessageId = resolveTelegramMessageIdOrThrow(await sendTelegramText(followUpText, textParams), "text follow-up send");
			recordSentMessage(chatId, textMessageId);
			return {
				messageId: String(textMessageId),
				chatId: resolvedChatId
			};
		}
		return {
			messageId: String(mediaMessageId),
			chatId: resolvedChatId
		};
	}
	if (!text || !text.trim()) throw new Error("Message must be non-empty for Telegram sends");
	const res = await sendTelegramText(text, hasThreadParams || replyMarkup ? {
		...threadParams,
		...replyMarkup ? { reply_markup: replyMarkup } : {}
	} : void 0, opts.plainText);
	const messageId = resolveTelegramMessageIdOrThrow(res, "text send");
	recordSentMessage(chatId, messageId);
	recordChannelActivity({
		channel: "telegram",
		accountId: account.accountId,
		direction: "outbound"
	});
	return {
		messageId: String(messageId),
		chatId: String(res?.chat?.id ?? chatId)
	};
}
async function reactMessageTelegram(chatIdInput, messageIdInput, emoji, opts = {}) {
	const { cfg, account, api } = resolveTelegramApiContext(opts);
	const rawTarget = String(chatIdInput);
	const chatId = await resolveAndPersistChatId({
		cfg,
		api,
		lookupTarget: rawTarget,
		persistTarget: rawTarget,
		verbose: opts.verbose
	});
	const messageId = normalizeMessageId(messageIdInput);
	const requestWithDiag = createTelegramRequestWithDiag({
		cfg,
		account,
		retry: opts.retry,
		verbose: opts.verbose,
		shouldRetry: (err) => isRecoverableTelegramNetworkError(err, { context: "send" })
	});
	const remove = opts.remove === true;
	const trimmedEmoji = emoji.trim();
	const reactions = remove || !trimmedEmoji ? [] : [{
		type: "emoji",
		emoji: trimmedEmoji
	}];
	if (typeof api.setMessageReaction !== "function") throw new Error("Telegram reactions are unavailable in this bot API.");
	try {
		await requestWithDiag(() => api.setMessageReaction(chatId, messageId, reactions), "reaction");
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (/REACTION_INVALID/i.test(msg)) return {
			ok: false,
			warning: `Reaction unavailable: ${trimmedEmoji}`
		};
		throw err;
	}
	return { ok: true };
}
async function deleteMessageTelegram(chatIdInput, messageIdInput, opts = {}) {
	const { cfg, account, api } = resolveTelegramApiContext(opts);
	const rawTarget = String(chatIdInput);
	const chatId = await resolveAndPersistChatId({
		cfg,
		api,
		lookupTarget: rawTarget,
		persistTarget: rawTarget,
		verbose: opts.verbose
	});
	const messageId = normalizeMessageId(messageIdInput);
	await createTelegramRequestWithDiag({
		cfg,
		account,
		retry: opts.retry,
		verbose: opts.verbose,
		shouldRetry: (err) => isRecoverableTelegramNetworkError(err, { context: "send" })
	})(() => api.deleteMessage(chatId, messageId), "deleteMessage");
	logVerbose(`[telegram] Deleted message ${messageId} from chat ${chatId}`);
	return { ok: true };
}
async function editMessageTelegram(chatIdInput, messageIdInput, text, opts = {}) {
	const { cfg, account, api } = resolveTelegramApiContext({
		...opts,
		cfg: opts.cfg
	});
	const rawTarget = String(chatIdInput);
	const chatId = await resolveAndPersistChatId({
		cfg,
		api,
		lookupTarget: rawTarget,
		persistTarget: rawTarget,
		verbose: opts.verbose
	});
	const messageId = normalizeMessageId(messageIdInput);
	const requestWithDiag = createTelegramRequestWithDiag({
		cfg,
		account,
		retry: opts.retry,
		verbose: opts.verbose
	});
	const requestWithEditShouldLog = (fn, label, shouldLog) => requestWithDiag(fn, label, shouldLog ? { shouldLog } : void 0);
	const htmlText = renderTelegramHtmlText(text, {
		textMode: opts.textMode ?? "markdown",
		tableMode: resolveMarkdownTableMode({
			cfg,
			channel: "telegram",
			accountId: account.accountId
		})
	});
	const shouldTouchButtons = opts.buttons !== void 0;
	const builtKeyboard = shouldTouchButtons ? buildInlineKeyboard(opts.buttons) : void 0;
	const replyMarkup = shouldTouchButtons ? builtKeyboard ?? { inline_keyboard: [] } : void 0;
	const editParams = { parse_mode: "HTML" };
	if (opts.linkPreview === false) editParams.link_preview_options = { is_disabled: true };
	if (replyMarkup !== void 0) editParams.reply_markup = replyMarkup;
	const plainParams = {};
	if (opts.linkPreview === false) plainParams.link_preview_options = { is_disabled: true };
	if (replyMarkup !== void 0) plainParams.reply_markup = replyMarkup;
	try {
		await withTelegramHtmlParseFallback({
			label: "editMessage",
			verbose: opts.verbose,
			requestHtml: (retryLabel) => requestWithEditShouldLog(() => api.editMessageText(chatId, messageId, htmlText, editParams), retryLabel, (err) => !isTelegramMessageNotModifiedError(err)),
			requestPlain: (retryLabel) => requestWithEditShouldLog(() => Object.keys(plainParams).length > 0 ? api.editMessageText(chatId, messageId, text, plainParams) : api.editMessageText(chatId, messageId, text), retryLabel, (plainErr) => !isTelegramMessageNotModifiedError(plainErr))
		});
	} catch (err) {
		if (isTelegramMessageNotModifiedError(err)) {} else throw err;
	}
	logVerbose(`[telegram] Edited message ${messageId} in chat ${chatId}`);
	return {
		ok: true,
		messageId: String(messageId),
		chatId
	};
}
function inferFilename(kind) {
	switch (kind) {
		case "image": return "image.jpg";
		case "video": return "video.mp4";
		case "audio": return "audio.ogg";
		default: return "file.bin";
	}
}
/**
* Send a sticker to a Telegram chat by file_id.
* @param to - Chat ID or username (e.g., "123456789" or "@username")
* @param fileId - Telegram file_id of the sticker to send
* @param opts - Optional configuration
*/
async function sendStickerTelegram(to, fileId, opts = {}) {
	if (!fileId?.trim()) throw new Error("Telegram sticker file_id is required");
	const { cfg, account, api } = resolveTelegramApiContext(opts);
	const target = parseTelegramTarget(to);
	const chatId = await resolveAndPersistChatId({
		cfg,
		api,
		lookupTarget: target.chatId,
		persistTarget: to,
		verbose: opts.verbose
	});
	const threadParams = buildTelegramThreadReplyParams({
		targetMessageThreadId: target.messageThreadId,
		messageThreadId: opts.messageThreadId,
		chatType: target.chatType,
		replyToMessageId: opts.replyToMessageId
	});
	const hasThreadParams = Object.keys(threadParams).length > 0;
	const requestWithChatNotFound = createRequestWithChatNotFound({
		requestWithDiag: createTelegramRequestWithDiag({
			cfg,
			account,
			retry: opts.retry,
			verbose: opts.verbose,
			useApiErrorLogging: false
		}),
		chatId,
		input: to
	});
	const result = await withTelegramThreadFallback(hasThreadParams ? threadParams : void 0, "sticker", opts.verbose, async (effectiveParams, label) => requestWithChatNotFound(() => api.sendSticker(chatId, fileId.trim(), effectiveParams), label));
	const messageId = resolveTelegramMessageIdOrThrow(result, "sticker send");
	const resolvedChatId = String(result?.chat?.id ?? chatId);
	recordSentMessage(chatId, messageId);
	recordChannelActivity({
		channel: "telegram",
		accountId: account.accountId,
		direction: "outbound"
	});
	return {
		messageId: String(messageId),
		chatId: resolvedChatId
	};
}
/**
* Send a poll to a Telegram chat.
* @param to - Chat ID or username (e.g., "123456789" or "@username")
* @param poll - Poll input with question, options, maxSelections, and optional durationHours
* @param opts - Optional configuration
*/
async function sendPollTelegram(to, poll, opts = {}) {
	const { cfg, account, api } = resolveTelegramApiContext(opts);
	const target = parseTelegramTarget(to);
	const chatId = await resolveAndPersistChatId({
		cfg,
		api,
		lookupTarget: target.chatId,
		persistTarget: to,
		verbose: opts.verbose
	});
	const normalizedPoll = normalizePollInput(poll, { maxOptions: 10 });
	const threadParams = buildTelegramThreadReplyParams({
		targetMessageThreadId: target.messageThreadId,
		messageThreadId: opts.messageThreadId,
		chatType: target.chatType,
		replyToMessageId: opts.replyToMessageId
	});
	const pollOptions = normalizedPoll.options;
	const requestWithChatNotFound = createRequestWithChatNotFound({
		requestWithDiag: createTelegramRequestWithDiag({
			cfg,
			account,
			retry: opts.retry,
			verbose: opts.verbose,
			shouldRetry: (err) => isRecoverableTelegramNetworkError(err, { context: "send" })
		}),
		chatId,
		input: to
	});
	const durationSeconds = normalizedPoll.durationSeconds;
	if (durationSeconds === void 0 && normalizedPoll.durationHours !== void 0) throw new Error("Telegram poll durationHours is not supported. Use durationSeconds (5-600) instead.");
	if (durationSeconds !== void 0 && (durationSeconds < 5 || durationSeconds > 600)) throw new Error("Telegram poll durationSeconds must be between 5 and 600");
	const result = await withTelegramThreadFallback({
		allows_multiple_answers: normalizedPoll.maxSelections > 1,
		is_anonymous: opts.isAnonymous ?? true,
		...durationSeconds !== void 0 ? { open_period: durationSeconds } : {},
		...Object.keys(threadParams).length > 0 ? threadParams : {},
		...opts.silent === true ? { disable_notification: true } : {}
	}, "poll", opts.verbose, async (effectiveParams, label) => requestWithChatNotFound(() => api.sendPoll(chatId, normalizedPoll.question, pollOptions, effectiveParams), label));
	const messageId = resolveTelegramMessageIdOrThrow(result, "poll send");
	const resolvedChatId = String(result?.chat?.id ?? chatId);
	const pollId = result?.poll?.id;
	recordSentMessage(chatId, messageId);
	recordChannelActivity({
		channel: "telegram",
		accountId: account.accountId,
		direction: "outbound"
	});
	return {
		messageId: String(messageId),
		chatId: resolvedChatId,
		pollId
	};
}
/**
* Create a forum topic in a Telegram supergroup.
* Requires the bot to have `can_manage_topics` permission.
*
* @param chatId - Supergroup chat ID
* @param name - Topic name (1-128 characters)
* @param opts - Optional configuration
*/
async function createForumTopicTelegram(chatId, name, opts = {}) {
	if (!name?.trim()) throw new Error("Forum topic name is required");
	const trimmedName = name.trim();
	if (trimmedName.length > 128) throw new Error("Forum topic name must be 128 characters or fewer");
	const cfg = loadConfig();
	const account = resolveTelegramAccount({
		cfg,
		accountId: opts.accountId
	});
	const token = resolveToken(opts.token, account);
	const client = resolveTelegramClientOptions(account);
	const api = opts.api ?? new Bot(token, client ? { client } : void 0).api;
	const normalizedChatId = await resolveAndPersistChatId({
		cfg,
		api,
		lookupTarget: parseTelegramTarget(chatId).chatId,
		persistTarget: chatId,
		verbose: opts.verbose
	});
	const request = createTelegramRetryRunner({
		retry: opts.retry,
		configRetry: account.config.retry,
		verbose: opts.verbose,
		shouldRetry: (err) => isRecoverableTelegramNetworkError(err, { context: "send" })
	});
	const logHttpError = createTelegramHttpLogger(cfg);
	const requestWithDiag = (fn, label) => withTelegramApiErrorLogging({
		operation: label ?? "request",
		fn: () => request(fn, label)
	}).catch((err) => {
		logHttpError(label ?? "request", err);
		throw err;
	});
	const extra = {};
	if (opts.iconColor != null) extra.icon_color = opts.iconColor;
	if (opts.iconCustomEmojiId?.trim()) extra.icon_custom_emoji_id = opts.iconCustomEmojiId.trim();
	const hasExtra = Object.keys(extra).length > 0;
	const result = await requestWithDiag(() => api.createForumTopic(normalizedChatId, trimmedName, hasExtra ? extra : void 0), "createForumTopic");
	const topicId = result.message_thread_id;
	recordChannelActivity({
		channel: "telegram",
		accountId: account.accountId,
		direction: "outbound"
	});
	return {
		topicId,
		name: result.name ?? trimmedName,
		chatId: normalizedChatId
	};
}

//#endregion
export { readChannelAllowFromStore as $, hasBotMention as A, normalizeDmAllowFromWithStore as B, buildTelegramGroupPeerId as C, describeReplyTarget as D, buildTypingThreadParams as E, resolveTelegramReplyId as F, parseTelegramTarget as G, withTelegramApiErrorLogging as H, resolveTelegramStreamMode as I, toLocationContext as J, resolveTelegramTargetChatType as K, resolveTelegramThreadSpec as L, resolveTelegramForumThreadId as M, resolveTelegramGroupAllowFromContext as N, expandTextLinks as O, resolveTelegramMediaPlaceholder as P, addChannelAllowFromStoreEntry as Q, isSenderAllowed as R, buildTelegramGroupFrom as S, buildTelegramThreadParams as T, isVoiceCompatibleAudio as U, resolveSenderAllowMatch as V, normalizeTelegramLookupTarget as W, isWSLEnv as X, isWSL2Sync as Y, isWSLSync as Z, resolveTelegramFetch as _, reactMessageTelegram as a, getPairingAdapter as at, buildSenderLabel as b, sendStickerTelegram as c, isSenderIdAllowed as ct, wasSentByBot as d, readChannelAllowFromStoreSync as et, isRecoverableTelegramNetworkError as f, wrapFileReferencesInHtml as g, renderTelegramHtmlText as h, editMessageTelegram as i, writeJsonFileAtomically as it, normalizeForwardedContext as j, extractTelegramLocation as k, send_exports as l, mergeDmAllowFromSources as lt, markdownToTelegramHtml as m, createForumTopicTelegram as n, upsertChannelPairingRequest as nt, sendMessageTelegram as o, listPairingChannels as ot, markdownToTelegramChunks as p, formatLocationText as q, deleteMessageTelegram as r, readJsonFileWithFallback as rt, sendPollTelegram as s, firstDefined as st, buildInlineKeyboard as t, removeChannelAllowFromStoreEntry as tt, resolveTelegramVoiceSend as u, resolveGroupAllowFromSources as ut, splitTelegramCaption as v, buildTelegramParentPeer as w, buildSenderName as x, buildGroupLabel as y, normalizeAllowFrom as z };