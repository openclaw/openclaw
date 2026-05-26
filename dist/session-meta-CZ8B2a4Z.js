import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { c as parseAgentSessionKey } from "./session-key-utils-Ce_xWkNq.js";
import { i as getRuntimeConfig } from "./io-DoswVvYe.js";
import "./config-B6Oplu5W.js";
import { u as resolveStorePath } from "./paths-Bg3PO6Gj.js";
import { t as loadSessionStore } from "./store-load-z4thf6ld.js";
import { n as mergeSessionEntry } from "./types-BgvyBC-3.js";
import { r as resolveAllAgentSessionStoreTargets } from "./targets-B5o7Ubgb.js";
//#region src/acp/runtime/session-meta.ts
let sessionStoreRuntimePromise;
function loadSessionStoreRuntime() {
	sessionStoreRuntimePromise ??= import("./store.runtime.js");
	return sessionStoreRuntimePromise;
}
function resolveStoreSessionKey(store, sessionKey) {
	const normalized = sessionKey.trim();
	if (!normalized) return "";
	if (store[normalized]) return normalized;
	const lower = normalizeLowercaseStringOrEmpty(normalized);
	if (store[lower]) return lower;
	for (const key of Object.keys(store)) if (normalizeLowercaseStringOrEmpty(key) === lower) return key;
	return lower;
}
function resolveSessionStorePathForAcp(params) {
	const cfg = params.cfg ?? getRuntimeConfig();
	const parsed = parseAgentSessionKey(params.sessionKey);
	return {
		cfg,
		storePath: resolveStorePath(cfg.session?.store, { agentId: parsed?.agentId })
	};
}
function readAcpSessionEntry(params) {
	const sessionKey = params.sessionKey.trim();
	if (!sessionKey) return null;
	const { cfg, storePath } = resolveSessionStorePathForAcp({
		sessionKey,
		cfg: params.cfg
	});
	let store;
	let storeReadFailed = false;
	try {
		store = loadSessionStore(storePath);
	} catch {
		storeReadFailed = true;
		store = {};
	}
	const storeSessionKey = resolveStoreSessionKey(store, sessionKey);
	const entry = store[storeSessionKey];
	return {
		cfg,
		storePath,
		sessionKey,
		storeSessionKey,
		entry,
		acp: entry?.acp,
		storeReadFailed
	};
}
async function listAcpSessionEntries(params) {
	const cfg = params.cfg ?? getRuntimeConfig();
	const storeTargets = await resolveAllAgentSessionStoreTargets(cfg, params.env ? { env: params.env } : void 0);
	const entries = [];
	for (const target of storeTargets) {
		const storePath = target.storePath;
		let store;
		try {
			store = loadSessionStore(storePath);
		} catch {
			continue;
		}
		for (const [sessionKey, entry] of Object.entries(store)) {
			if (!entry?.acp) continue;
			entries.push({
				cfg,
				storePath,
				sessionKey,
				storeSessionKey: sessionKey,
				entry,
				acp: entry.acp
			});
		}
	}
	return entries;
}
async function upsertAcpSessionMeta(params) {
	const sessionKey = params.sessionKey.trim();
	if (!sessionKey) return null;
	const { storePath } = resolveSessionStorePathForAcp({
		sessionKey,
		cfg: params.cfg
	});
	const { updateSessionStore } = await loadSessionStoreRuntime();
	return await updateSessionStore(storePath, (store) => {
		const storeSessionKey = resolveStoreSessionKey(store, sessionKey);
		const currentEntry = store[storeSessionKey];
		const nextMeta = params.mutate(currentEntry?.acp, currentEntry);
		if (nextMeta === void 0) return currentEntry ?? null;
		if (nextMeta === null && !currentEntry) return null;
		const nextEntry = mergeSessionEntry(currentEntry, { acp: nextMeta ?? void 0 });
		if (nextMeta === null) delete nextEntry.acp;
		store[storeSessionKey] = nextEntry;
		return nextEntry;
	}, {
		activeSessionKey: normalizeLowercaseStringOrEmpty(sessionKey),
		allowDropAcpMetaSessionKeys: [sessionKey]
	});
}
//#endregion
export { upsertAcpSessionMeta as i, readAcpSessionEntry as n, resolveSessionStorePathForAcp as r, listAcpSessionEntries as t };
