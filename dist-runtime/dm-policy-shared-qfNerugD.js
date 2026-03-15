import { _ as resolveStateDir, h as resolveOAuthDir, x as resolveRequiredHomeDir } from "./paths-1qR_mW4i.js";
import { b as safeParseJson } from "./utils-Do8MzKyM.js";
import { Tt as evaluateMatchedGroupAccessForPolicy, X as getChannelPlugin, Z as listChannelPlugins } from "./registry-DrRO3PZ7.js";
import "./account-id-CYKfwqh7.js";
import { r as writeJsonAtomic } from "./json-files-DTtlIKNR.js";
import { r as normalizeStringEntries } from "./string-normalization-CJJOCyGw.js";
import { c as isPidAlive, o as resolveProcessScopedMap } from "./commands-BRfqrztE.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import fs$1 from "node:fs/promises";
//#region src/plugin-sdk/json-store.ts
/** Read JSON from disk and fall back cleanly when the file is missing or invalid. */
async function readJsonFileWithFallback(filePath, fallback) {
	try {
		const parsed = safeParseJson(await fs.promises.readFile(filePath, "utf-8"));
		if (parsed == null) {return {
			value: fallback,
			exists: true
		};}
		return {
			value: parsed,
			exists: true
		};
	} catch (err) {
		if (err.code === "ENOENT") {return {
			value: fallback,
			exists: false
		};}
		return {
			value: fallback,
			exists: false
		};
	}
}
/** Write JSON with secure file permissions and atomic replacement semantics. */
async function writeJsonFileAtomically(filePath, value) {
	await writeJsonAtomic(filePath, value, {
		mode: 384,
		trailingNewline: true,
		ensureDirMode: 448
	});
}
//#endregion
//#region src/plugin-sdk/file-lock.ts
const HELD_LOCKS = resolveProcessScopedMap(Symbol.for("openclaw.fileLockHeldLocks"));
function computeDelayMs(retries, attempt) {
	const base = Math.min(retries.maxTimeout, Math.max(retries.minTimeout, retries.minTimeout * retries.factor ** attempt));
	const jitter = retries.randomize ? 1 + Math.random() : 1;
	return Math.min(retries.maxTimeout, Math.round(base * jitter));
}
async function readLockPayload(lockPath) {
	try {
		const raw = await fs$1.readFile(lockPath, "utf8");
		const parsed = JSON.parse(raw);
		if (typeof parsed.pid !== "number" || typeof parsed.createdAt !== "string") {return null;}
		return {
			pid: parsed.pid,
			createdAt: parsed.createdAt
		};
	} catch {
		return null;
	}
}
async function resolveNormalizedFilePath(filePath) {
	const resolved = path.resolve(filePath);
	const dir = path.dirname(resolved);
	await fs$1.mkdir(dir, { recursive: true });
	try {
		const realDir = await fs$1.realpath(dir);
		return path.join(realDir, path.basename(resolved));
	} catch {
		return resolved;
	}
}
async function isStaleLock(lockPath, staleMs) {
	const payload = await readLockPayload(lockPath);
	if (payload?.pid && !isPidAlive(payload.pid)) {return true;}
	if (payload?.createdAt) {
		const createdAt = Date.parse(payload.createdAt);
		if (!Number.isFinite(createdAt) || Date.now() - createdAt > staleMs) {return true;}
	}
	try {
		const stat = await fs$1.stat(lockPath);
		return Date.now() - stat.mtimeMs > staleMs;
	} catch {
		return true;
	}
}
async function releaseHeldLock(normalizedFile) {
	const current = HELD_LOCKS.get(normalizedFile);
	if (!current) {return;}
	current.count -= 1;
	if (current.count > 0) {return;}
	HELD_LOCKS.delete(normalizedFile);
	await current.handle.close().catch(() => void 0);
	await fs$1.rm(current.lockPath, { force: true }).catch(() => void 0);
}
/** Acquire a re-entrant process-local file lock backed by a `.lock` sidecar file. */
async function acquireFileLock(filePath, options) {
	const normalizedFile = await resolveNormalizedFilePath(filePath);
	const lockPath = `${normalizedFile}.lock`;
	const held = HELD_LOCKS.get(normalizedFile);
	if (held) {
		held.count += 1;
		return {
			lockPath,
			release: () => releaseHeldLock(normalizedFile)
		};
	}
	const attempts = Math.max(1, options.retries.retries + 1);
	for (let attempt = 0; attempt < attempts; attempt += 1) {try {
		const handle = await fs$1.open(lockPath, "wx");
		await handle.writeFile(JSON.stringify({
			pid: process.pid,
			createdAt: (/* @__PURE__ */ new Date()).toISOString()
		}, null, 2), "utf8");
		HELD_LOCKS.set(normalizedFile, {
			count: 1,
			handle,
			lockPath
		});
		return {
			lockPath,
			release: () => releaseHeldLock(normalizedFile)
		};
	} catch (err) {
		if (err.code !== "EEXIST") throw err;
		if (await isStaleLock(lockPath, options.stale)) {
			await fs$1.rm(lockPath, { force: true }).catch(() => void 0);
			continue;
		}
		if (attempt >= attempts - 1) break;
		await new Promise((resolve) => setTimeout(resolve, computeDelayMs(options.retries, attempt)));
	}}
	throw new Error(`file lock timeout for ${normalizedFile}`);
}
/** Run an async callback while holding a file lock, always releasing the lock afterward. */
async function withFileLock$1(filePath, options, fn) {
	const lock = await acquireFileLock(filePath, options);
	try {
		return await fn();
	} finally {
		await lock.release();
	}
}
//#endregion
//#region src/channels/plugins/pairing.ts
function listPairingChannels() {
	return listChannelPlugins().filter((plugin) => plugin.pairing).map((plugin) => plugin.id);
}
function getPairingAdapter(channelId) {
	return getChannelPlugin(channelId)?.pairing ?? null;
}
function requirePairingAdapter(channelId) {
	const adapter = getPairingAdapter(channelId);
	if (!adapter) {throw new Error(`Channel ${channelId} does not support pairing`);}
	return adapter;
}
async function notifyPairingApproved(params) {
	const adapter = params.pairingAdapter ?? requirePairingAdapter(params.channelId);
	if (!adapter.notifyApproval) {return;}
	await adapter.notifyApproval({
		cfg: params.cfg,
		id: params.id,
		runtime: params.runtime
	});
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
const allowFromReadCache = /* @__PURE__ */ new Map();
function resolveCredentialsDir(env = process.env) {
	return resolveOAuthDir(env, resolveStateDir(env, () => resolveRequiredHomeDir(env, os.homedir)));
}
/** Sanitize channel ID for use in filenames (prevent path traversal). */
function safeChannelKey(channel) {
	const raw = String(channel).trim().toLowerCase();
	if (!raw) {throw new Error("invalid pairing channel");}
	const safe = raw.replace(/[\\/:*?"<>|]/g, "_").replace(/\.\./g, "_");
	if (!safe || safe === "_") {throw new Error("invalid pairing channel");}
	return safe;
}
function resolvePairingPath(channel, env = process.env) {
	return path.join(resolveCredentialsDir(env), `${safeChannelKey(channel)}-pairing.json`);
}
function safeAccountKey(accountId) {
	const raw = String(accountId).trim().toLowerCase();
	if (!raw) {throw new Error("invalid pairing account id");}
	const safe = raw.replace(/[\\/:*?"<>|]/g, "_").replace(/\.\./g, "_");
	if (!safe || safe === "_") {throw new Error("invalid pairing account id");}
	return safe;
}
function resolveAllowFromPath(channel, env = process.env, accountId) {
	const base = safeChannelKey(channel);
	const normalizedAccountId = typeof accountId === "string" ? accountId.trim() : "";
	if (!normalizedAccountId) {return path.join(resolveCredentialsDir(env), `${base}-allowFrom.json`);}
	return path.join(resolveCredentialsDir(env), `${base}-${safeAccountKey(normalizedAccountId)}-allowFrom.json`);
}
function resolveChannelAllowFromPath(channel, env = process.env, accountId) {
	return resolveAllowFromPath(channel, env, accountId);
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
async function readPrunedPairingRequests(filePath) {
	return pruneExpiredRequests(await readPairingRequests(filePath), Date.now());
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
	if (!value) {return null;}
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed)) {return null;}
	return parsed;
}
function isExpired(entry, nowMs) {
	const createdAt = parseTimestamp(entry.createdAt);
	if (!createdAt) {return true;}
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
	if (maxPending <= 0 || reqs.length <= maxPending) {return {
		requests: reqs,
		removed: false
	};}
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
		if (!existing.has(code)) {return code;}
	}
	throw new Error("failed to generate unique pairing code");
}
function normalizePairingAccountId(accountId) {
	return accountId?.trim().toLowerCase() || "";
}
function requestMatchesAccountId(entry, normalizedAccountId) {
	if (!normalizedAccountId) {return true;}
	return String(entry.meta?.accountId ?? "").trim().toLowerCase() === normalizedAccountId;
}
function shouldIncludeLegacyAllowFromEntries(normalizedAccountId) {
	return !normalizedAccountId || normalizedAccountId === "default";
}
function resolveAllowFromAccountId(accountId) {
	return normalizePairingAccountId(accountId) || "default";
}
function normalizeId(value) {
	return String(value).trim();
}
function normalizeAllowEntry(channel, entry) {
	const trimmed = entry.trim();
	if (!trimmed) {return "";}
	if (trimmed === "*") {return "";}
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
		if (!normalized || seen.has(normalized)) {continue;}
		seen.add(normalized);
		out.push(normalized);
	}
	return out;
}
async function readAllowFromStateForPath(channel, filePath) {
	return (await readAllowFromStateForPathWithExists(channel, filePath)).entries;
}
function cloneAllowFromCacheEntry(entry) {
	return {
		exists: entry.exists,
		mtimeMs: entry.mtimeMs,
		size: entry.size,
		entries: entry.entries.slice()
	};
}
function setAllowFromReadCache(filePath, entry) {
	allowFromReadCache.set(filePath, cloneAllowFromCacheEntry(entry));
}
function resolveAllowFromReadCacheHit(params) {
	const cached = allowFromReadCache.get(params.filePath);
	if (!cached) {return null;}
	if (cached.exists !== params.exists) {return null;}
	if (!params.exists) {return cloneAllowFromCacheEntry(cached);}
	if (cached.mtimeMs !== params.mtimeMs || cached.size !== params.size) {return null;}
	return cloneAllowFromCacheEntry(cached);
}
function resolveAllowFromReadCacheOrMissing(filePath, stat) {
	const cached = resolveAllowFromReadCacheHit({
		filePath,
		exists: Boolean(stat),
		mtimeMs: stat?.mtimeMs ?? null,
		size: stat?.size ?? null
	});
	if (cached) {return {
		entries: cached.entries,
		exists: cached.exists
	};}
	if (!stat) {
		setAllowFromReadCache(filePath, {
			exists: false,
			mtimeMs: null,
			size: null,
			entries: []
		});
		return {
			entries: [],
			exists: false
		};
	}
	return null;
}
async function readAllowFromStateForPathWithExists(channel, filePath) {
	let stat = null;
	try {
		stat = await fs.promises.stat(filePath);
	} catch (err) {
		if (err.code !== "ENOENT") {throw err;}
	}
	const cachedOrMissing = resolveAllowFromReadCacheOrMissing(filePath, stat);
	if (cachedOrMissing) {return cachedOrMissing;}
	if (!stat) {return {
		entries: [],
		exists: false
	};}
	const { value, exists } = await readJsonFile(filePath, {
		version: 1,
		allowFrom: []
	});
	const entries = normalizeAllowFromList(channel, value);
	setAllowFromReadCache(filePath, {
		exists,
		mtimeMs: stat.mtimeMs,
		size: stat.size,
		entries
	});
	return {
		entries,
		exists
	};
}
function readAllowFromStateForPathSync(channel, filePath) {
	return readAllowFromStateForPathSyncWithExists(channel, filePath).entries;
}
function readAllowFromStateForPathSyncWithExists(channel, filePath) {
	let stat = null;
	try {
		stat = fs.statSync(filePath);
	} catch (err) {
		if (err.code !== "ENOENT") {return {
			entries: [],
			exists: false
		};}
	}
	const cachedOrMissing = resolveAllowFromReadCacheOrMissing(filePath, stat);
	if (cachedOrMissing) {return cachedOrMissing;}
	if (!stat) {return {
		entries: [],
		exists: false
	};}
	let raw = "";
	try {
		raw = fs.readFileSync(filePath, "utf8");
	} catch (err) {
		if (err.code === "ENOENT") {return {
			entries: [],
			exists: false
		};}
		return {
			entries: [],
			exists: false
		};
	}
	try {
		const entries = normalizeAllowFromList(channel, JSON.parse(raw));
		setAllowFromReadCache(filePath, {
			exists: true,
			mtimeMs: stat.mtimeMs,
			size: stat.size,
			entries
		});
		return {
			entries,
			exists: true
		};
	} catch {
		setAllowFromReadCache(filePath, {
			exists: true,
			mtimeMs: stat.mtimeMs,
			size: stat.size,
			entries: []
		});
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
	let stat = null;
	try {
		stat = await fs.promises.stat(filePath);
	} catch {}
	setAllowFromReadCache(filePath, {
		exists: true,
		mtimeMs: stat?.mtimeMs ?? null,
		size: stat?.size ?? null,
		entries: allowFrom.slice()
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
		if (!normalized) {return {
			changed: false,
			allowFrom: current
		};}
		const next = params.apply(current, normalized);
		if (!next) {return {
			changed: false,
			allowFrom: current
		};}
		await writeAllowFromState(filePath, next);
		return {
			changed: true,
			allowFrom: next
		};
	});
}
async function readChannelAllowFromStore(channel, env = process.env, accountId) {
	const resolvedAccountId = resolveAllowFromAccountId(accountId);
	if (!shouldIncludeLegacyAllowFromEntries(resolvedAccountId)) {return await readNonDefaultAccountAllowFrom({
		channel,
		env,
		accountId: resolvedAccountId
	});}
	const scopedEntries = await readAllowFromStateForPath(channel, resolveAllowFromPath(channel, env, resolvedAccountId));
	const legacyEntries = await readAllowFromStateForPath(channel, resolveAllowFromPath(channel, env));
	return dedupePreserveOrder([...scopedEntries, ...legacyEntries]);
}
function readChannelAllowFromStoreSync(channel, env = process.env, accountId) {
	const resolvedAccountId = resolveAllowFromAccountId(accountId);
	if (!shouldIncludeLegacyAllowFromEntries(resolvedAccountId)) {return readNonDefaultAccountAllowFromSync({
		channel,
		env,
		accountId: resolvedAccountId
	});}
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
		if (current.includes(normalized)) {return null;}
		return [...current, normalized];
	});
}
async function removeChannelAllowFromStoreEntry(params) {
	return await mutateChannelAllowFromStoreEntry(params, (current, normalized) => {
		const next = current.filter((entry) => entry !== normalized);
		if (next.length === current.length) {return null;}
		return next;
	});
}
async function listChannelPairingRequests(channel, env = process.env, accountId) {
	const filePath = resolvePairingPath(channel, env);
	return await withFileLock(filePath, {
		version: 1,
		requests: []
	}, async () => {
		const { requests: prunedExpired, removed: expiredRemoved } = await readPrunedPairingRequests(filePath);
		const { requests: pruned, removed: cappedRemoved } = pruneExcessRequests(prunedExpired, PAIRING_PENDING_MAX);
		if (expiredRemoved || cappedRemoved) {await writeJsonFile(filePath, {
			version: 1,
			requests: pruned
		});}
		const normalizedAccountId = normalizePairingAccountId(accountId);
		return (normalizedAccountId ? pruned.filter((entry) => requestMatchesAccountId(entry, normalizedAccountId)) : pruned).filter((r) => r && typeof r.id === "string" && typeof r.code === "string" && typeof r.createdAt === "string").slice().toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
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
		const normalizedAccountId = normalizePairingAccountId(params.accountId) || "default";
		const meta = {
			...params.meta && typeof params.meta === "object" ? Object.fromEntries(Object.entries(params.meta).map(([k, v]) => [k, String(v ?? "").trim()]).filter(([_, v]) => Boolean(v))) : void 0,
			accountId: normalizedAccountId
		};
		let reqs = await readPairingRequests(filePath);
		const { requests: prunedExpired, removed: expiredRemoved } = pruneExpiredRequests(reqs, nowMs);
		reqs = prunedExpired;
		const normalizedMatchingAccountId = normalizedAccountId;
		const existingIdx = reqs.findIndex((r) => {
			if (r.id !== id) {return false;}
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
			if (expiredRemoved || cappedRemoved) {await writeJsonFile(filePath, {
				version: 1,
				requests: reqs
			});}
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
async function approveChannelPairingCode(params) {
	const env = params.env ?? process.env;
	const code = params.code.trim().toUpperCase();
	if (!code) {return null;}
	const filePath = resolvePairingPath(params.channel, env);
	return await withFileLock(filePath, {
		version: 1,
		requests: []
	}, async () => {
		const { requests: pruned, removed } = await readPrunedPairingRequests(filePath);
		const normalizedAccountId = normalizePairingAccountId(params.accountId);
		const idx = pruned.findIndex((r) => {
			if (String(r.code ?? "").toUpperCase() !== code) {return false;}
			return requestMatchesAccountId(r, normalizedAccountId);
		});
		if (idx < 0) {
			if (removed) {await writeJsonFile(filePath, {
				version: 1,
				requests: pruned
			});}
			return null;
		}
		const entry = pruned[idx];
		if (!entry) {return null;}
		pruned.splice(idx, 1);
		await writeJsonFile(filePath, {
			version: 1,
			requests: pruned
		});
		const entryAccountId = String(entry.meta?.accountId ?? "").trim() || void 0;
		await addChannelAllowFromStoreEntry({
			channel: params.channel,
			entry: entry.id,
			accountId: params.accountId?.trim() || entryAccountId,
			env
		});
		return {
			id: entry.id,
			entry
		};
	});
}
//#endregion
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
	for (const value of values) {if (typeof value !== "undefined") return value;}
}
function isSenderIdAllowed(allow, senderId, allowWhenEmpty) {
	if (!allow.hasEntries) {return allowWhenEmpty;}
	if (allow.hasWildcard) {return true;}
	if (!senderId) {return false;}
	return allow.entries.includes(senderId);
}
//#endregion
//#region src/channels/command-gating.ts
function resolveCommandAuthorizedFromAuthorizers(params) {
	const { useAccessGroups, authorizers } = params;
	const mode = params.modeWhenAccessGroupsOff ?? "allow";
	if (!useAccessGroups) {
		if (mode === "allow") {return true;}
		if (mode === "deny") {return false;}
		if (!authorizers.some((entry) => entry.configured)) {return true;}
		return authorizers.some((entry) => entry.configured && entry.allowed);
	}
	return authorizers.some((entry) => entry.configured && entry.allowed);
}
function resolveControlCommandGate(params) {
	const commandAuthorized = resolveCommandAuthorizedFromAuthorizers({
		useAccessGroups: params.useAccessGroups,
		authorizers: params.authorizers,
		modeWhenAccessGroupsOff: params.modeWhenAccessGroupsOff
	});
	return {
		commandAuthorized,
		shouldBlock: params.allowTextCommands && params.hasControlCommand && !commandAuthorized
	};
}
function resolveDualTextControlCommandGate(params) {
	return resolveControlCommandGate({
		useAccessGroups: params.useAccessGroups,
		authorizers: [{
			configured: params.primaryConfigured,
			allowed: params.primaryAllowed
		}, {
			configured: params.secondaryConfigured,
			allowed: params.secondaryAllowed
		}],
		allowTextCommands: true,
		hasControlCommand: params.hasControlCommand,
		modeWhenAccessGroupsOff: params.modeWhenAccessGroupsOff
	});
}
//#endregion
//#region src/security/dm-policy-shared.ts
function resolvePinnedMainDmOwnerFromAllowlist(params) {
	if ((params.dmScope ?? "main") !== "main") {return null;}
	const rawAllowFrom = Array.isArray(params.allowFrom) ? params.allowFrom : [];
	if (rawAllowFrom.some((entry) => String(entry).trim() === "*")) {return null;}
	const normalizedOwners = Array.from(new Set(rawAllowFrom.map((entry) => params.normalizeEntry(String(entry))).filter((entry) => Boolean(entry))));
	return normalizedOwners.length === 1 ? normalizedOwners[0] : null;
}
function resolveEffectiveAllowFromLists(params) {
	const allowFrom = Array.isArray(params.allowFrom) ? params.allowFrom : void 0;
	const groupAllowFrom = Array.isArray(params.groupAllowFrom) ? params.groupAllowFrom : void 0;
	return {
		effectiveAllowFrom: normalizeStringEntries(mergeDmAllowFromSources({
			allowFrom,
			storeAllowFrom: Array.isArray(params.storeAllowFrom) ? params.storeAllowFrom : void 0,
			dmPolicy: params.dmPolicy ?? void 0
		})),
		effectiveGroupAllowFrom: normalizeStringEntries(resolveGroupAllowFromSources({
			allowFrom,
			groupAllowFrom,
			fallbackToAllowFrom: params.groupAllowFromFallbackToAllowFrom ?? void 0
		}))
	};
}
const DM_GROUP_ACCESS_REASON = {
	GROUP_POLICY_ALLOWED: "group_policy_allowed",
	GROUP_POLICY_DISABLED: "group_policy_disabled",
	GROUP_POLICY_EMPTY_ALLOWLIST: "group_policy_empty_allowlist",
	GROUP_POLICY_NOT_ALLOWLISTED: "group_policy_not_allowlisted",
	DM_POLICY_OPEN: "dm_policy_open",
	DM_POLICY_DISABLED: "dm_policy_disabled",
	DM_POLICY_ALLOWLISTED: "dm_policy_allowlisted",
	DM_POLICY_PAIRING_REQUIRED: "dm_policy_pairing_required",
	DM_POLICY_NOT_ALLOWLISTED: "dm_policy_not_allowlisted"
};
async function readStoreAllowFromForDmPolicy(params) {
	if (params.shouldRead === false || params.dmPolicy === "allowlist") {return [];}
	return await (params.readStore ?? ((provider, accountId) => readChannelAllowFromStore(provider, process.env, accountId)))(params.provider, params.accountId).catch(() => []);
}
function resolveDmGroupAccessDecision(params) {
	const dmPolicy = params.dmPolicy ?? "pairing";
	const groupPolicy = params.groupPolicy === "open" || params.groupPolicy === "disabled" ? params.groupPolicy : "allowlist";
	const effectiveAllowFrom = normalizeStringEntries(params.effectiveAllowFrom);
	const effectiveGroupAllowFrom = normalizeStringEntries(params.effectiveGroupAllowFrom);
	if (params.isGroup) {
		const groupAccess = evaluateMatchedGroupAccessForPolicy({
			groupPolicy,
			allowlistConfigured: effectiveGroupAllowFrom.length > 0,
			allowlistMatched: params.isSenderAllowed(effectiveGroupAllowFrom)
		});
		if (!groupAccess.allowed) {
			if (groupAccess.reason === "disabled") {return {
				decision: "block",
				reasonCode: DM_GROUP_ACCESS_REASON.GROUP_POLICY_DISABLED,
				reason: "groupPolicy=disabled"
			};}
			if (groupAccess.reason === "empty_allowlist") {return {
				decision: "block",
				reasonCode: DM_GROUP_ACCESS_REASON.GROUP_POLICY_EMPTY_ALLOWLIST,
				reason: "groupPolicy=allowlist (empty allowlist)"
			};}
			if (groupAccess.reason === "not_allowlisted") {return {
				decision: "block",
				reasonCode: DM_GROUP_ACCESS_REASON.GROUP_POLICY_NOT_ALLOWLISTED,
				reason: "groupPolicy=allowlist (not allowlisted)"
			};}
		}
		return {
			decision: "allow",
			reasonCode: DM_GROUP_ACCESS_REASON.GROUP_POLICY_ALLOWED,
			reason: `groupPolicy=${groupPolicy}`
		};
	}
	if (dmPolicy === "disabled") {return {
		decision: "block",
		reasonCode: DM_GROUP_ACCESS_REASON.DM_POLICY_DISABLED,
		reason: "dmPolicy=disabled"
	};}
	if (dmPolicy === "open") {return {
		decision: "allow",
		reasonCode: DM_GROUP_ACCESS_REASON.DM_POLICY_OPEN,
		reason: "dmPolicy=open"
	};}
	if (params.isSenderAllowed(effectiveAllowFrom)) {return {
		decision: "allow",
		reasonCode: DM_GROUP_ACCESS_REASON.DM_POLICY_ALLOWLISTED,
		reason: `dmPolicy=${dmPolicy} (allowlisted)`
	};}
	if (dmPolicy === "pairing") {return {
		decision: "pairing",
		reasonCode: DM_GROUP_ACCESS_REASON.DM_POLICY_PAIRING_REQUIRED,
		reason: "dmPolicy=pairing (not allowlisted)"
	};}
	return {
		decision: "block",
		reasonCode: DM_GROUP_ACCESS_REASON.DM_POLICY_NOT_ALLOWLISTED,
		reason: `dmPolicy=${dmPolicy} (not allowlisted)`
	};
}
function resolveDmGroupAccessWithLists(params) {
	const { effectiveAllowFrom, effectiveGroupAllowFrom } = resolveEffectiveAllowFromLists({
		allowFrom: params.allowFrom,
		groupAllowFrom: params.groupAllowFrom,
		storeAllowFrom: params.storeAllowFrom,
		dmPolicy: params.dmPolicy,
		groupAllowFromFallbackToAllowFrom: params.groupAllowFromFallbackToAllowFrom
	});
	return {
		...resolveDmGroupAccessDecision({
			isGroup: params.isGroup,
			dmPolicy: params.dmPolicy,
			groupPolicy: params.groupPolicy,
			effectiveAllowFrom,
			effectiveGroupAllowFrom,
			isSenderAllowed: params.isSenderAllowed
		}),
		effectiveAllowFrom,
		effectiveGroupAllowFrom
	};
}
function resolveDmGroupAccessWithCommandGate(params) {
	const access = resolveDmGroupAccessWithLists({
		isGroup: params.isGroup,
		dmPolicy: params.dmPolicy,
		groupPolicy: params.groupPolicy,
		allowFrom: params.allowFrom,
		groupAllowFrom: params.groupAllowFrom,
		storeAllowFrom: params.storeAllowFrom,
		groupAllowFromFallbackToAllowFrom: params.groupAllowFromFallbackToAllowFrom,
		isSenderAllowed: params.isSenderAllowed
	});
	const configuredAllowFrom = normalizeStringEntries(params.allowFrom ?? []);
	const configuredGroupAllowFrom = normalizeStringEntries(resolveGroupAllowFromSources({
		allowFrom: configuredAllowFrom,
		groupAllowFrom: normalizeStringEntries(params.groupAllowFrom ?? []),
		fallbackToAllowFrom: params.groupAllowFromFallbackToAllowFrom ?? void 0
	}));
	const commandDmAllowFrom = params.isGroup ? configuredAllowFrom : access.effectiveAllowFrom;
	const commandGroupAllowFrom = params.isGroup ? configuredGroupAllowFrom : access.effectiveGroupAllowFrom;
	const ownerAllowedForCommands = params.isSenderAllowed(commandDmAllowFrom);
	const groupAllowedForCommands = params.isSenderAllowed(commandGroupAllowFrom);
	const commandGate = params.command ? resolveControlCommandGate({
		useAccessGroups: params.command.useAccessGroups,
		authorizers: [{
			configured: commandDmAllowFrom.length > 0,
			allowed: ownerAllowedForCommands
		}, {
			configured: commandGroupAllowFrom.length > 0,
			allowed: groupAllowedForCommands
		}],
		allowTextCommands: params.command.allowTextCommands,
		hasControlCommand: params.command.hasControlCommand
	}) : {
		commandAuthorized: false,
		shouldBlock: false
	};
	return {
		...access,
		commandAuthorized: commandGate.commandAuthorized,
		shouldBlockControlCommand: params.isGroup && commandGate.shouldBlock
	};
}
async function resolveDmAllowState(params) {
	const configAllowFrom = normalizeStringEntries(Array.isArray(params.allowFrom) ? params.allowFrom : void 0);
	const hasWildcard = configAllowFrom.includes("*");
	const storeAllowFrom = await readStoreAllowFromForDmPolicy({
		provider: params.provider,
		accountId: params.accountId,
		readStore: params.readStore
	});
	const normalizeEntry = params.normalizeEntry ?? ((value) => value);
	const normalizedCfg = configAllowFrom.filter((value) => value !== "*").map((value) => normalizeEntry(value)).map((value) => value.trim()).filter(Boolean);
	const normalizedStore = storeAllowFrom.map((value) => normalizeEntry(value)).map((value) => value.trim()).filter(Boolean);
	const allowCount = Array.from(new Set([...normalizedCfg, ...normalizedStore])).length;
	return {
		configAllowFrom,
		hasWildcard,
		allowCount,
		isMultiUserDm: hasWildcard || allowCount > 1
	};
}
//#endregion
export { listPairingChannels as C, writeJsonFileAtomically as D, readJsonFileWithFallback as E, getPairingAdapter as S, withFileLock$1 as T, readChannelAllowFromStore as _, resolveDmGroupAccessWithLists as a, resolveChannelAllowFromPath as b, resolveCommandAuthorizedFromAuthorizers as c, firstDefined as d, isSenderIdAllowed as f, listChannelPairingRequests as g, approveChannelPairingCode as h, resolveDmGroupAccessWithCommandGate as i, resolveControlCommandGate as l, addChannelAllowFromStoreEntry as m, readStoreAllowFromForDmPolicy as n, resolveEffectiveAllowFromLists as o, mergeDmAllowFromSources as p, resolveDmAllowState as r, resolvePinnedMainDmOwnerFromAllowlist as s, DM_GROUP_ACCESS_REASON as t, resolveDualTextControlCommandGate as u, readChannelAllowFromStoreSync as v, notifyPairingApproved as w, upsertChannelPairingRequest as x, removeChannelAllowFromStoreEntry as y };
