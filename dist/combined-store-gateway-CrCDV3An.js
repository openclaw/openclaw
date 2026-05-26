import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { o as parseAgentSessionKey } from "./session-key-utils-qD-NZHCY.js";
import { c as normalizeAgentId, l as normalizeMainKey } from "./session-key-DFEyR49L.js";
import { c as resolveDefaultAgentId, n as listAgentIds } from "./agent-scope-config-26EcJVc0.js";
import "./agent-scope-C1Fl7gAf.js";
import { i as resolveMainSessionKey, t as canonicalizeMainSessionAlias } from "./main-session-BkilxHe0.js";
import { u as resolveStorePath } from "./paths-kGAxo7MN.js";
import { t as loadSessionStore } from "./store-load-cmAGD4uk.js";
import { i as resolveSessionStoreTargets, r as resolveAllAgentSessionStoreTargetsSync, t as resolveAgentSessionStoreTargetsSync } from "./targets-DaLztPKR.js";
//#region src/gateway/session-store-key.ts
function canonicalizeSessionKeyForAgent(agentId, key) {
	const lowered = normalizeLowercaseStringOrEmpty(key);
	if (lowered === "global" || lowered === "unknown") return lowered;
	if (lowered.startsWith("agent:")) return lowered;
	return `agent:${normalizeAgentId(agentId)}:${lowered}`;
}
function resolveDefaultStoreAgentId(cfg) {
	return normalizeAgentId(resolveDefaultAgentId(cfg));
}
function shouldRemapLegacyDefaultMainAlias(cfg, parsed, options) {
	if (normalizeAgentId(parsed.agentId) !== "main" || listAgentIds(cfg).includes("main")) return false;
	const defaultAgentId = resolveDefaultStoreAgentId(cfg);
	if (options?.storeAgentId && normalizeAgentId(options.storeAgentId) !== defaultAgentId) return false;
	const rest = normalizeLowercaseStringOrEmpty(parsed.rest);
	const mainKey = normalizeMainKey(cfg.session?.mainKey);
	return rest === "main" || rest === mainKey;
}
function resolveParsedSessionStoreKey(cfg, raw, parsed, options) {
	if (!shouldRemapLegacyDefaultMainAlias(cfg, parsed, options)) return {
		agentId: normalizeAgentId(parsed.agentId),
		sessionKey: normalizeLowercaseStringOrEmpty(raw)
	};
	const agentId = resolveDefaultStoreAgentId(cfg);
	return {
		agentId,
		sessionKey: `agent:${agentId}:${normalizeLowercaseStringOrEmpty(parsed.rest)}`
	};
}
function resolveSessionStoreKey(params) {
	const raw = normalizeOptionalString(params.sessionKey) ?? "";
	if (!raw) return raw;
	const rawLower = normalizeLowercaseStringOrEmpty(raw);
	if (rawLower === "global" || rawLower === "unknown") return rawLower;
	const parsed = parseAgentSessionKey(raw);
	if (parsed) {
		const resolved = resolveParsedSessionStoreKey(params.cfg, raw, parsed, { storeAgentId: params.storeAgentId });
		const canonical = canonicalizeMainSessionAlias({
			cfg: params.cfg,
			agentId: resolved.agentId,
			sessionKey: resolved.sessionKey
		});
		if (canonical !== resolved.sessionKey) return canonical;
		return resolved.sessionKey;
	}
	const lowered = normalizeLowercaseStringOrEmpty(raw);
	const rawMainKey = normalizeMainKey(params.cfg.session?.mainKey);
	if (lowered === "main" || lowered === rawMainKey) return resolveMainSessionKey(params.cfg);
	return canonicalizeSessionKeyForAgent(resolveDefaultStoreAgentId(params.cfg), lowered);
}
function resolveSessionStoreAgentId(cfg, canonicalKey) {
	if (canonicalKey === "global" || canonicalKey === "unknown") return resolveDefaultStoreAgentId(cfg);
	const parsed = parseAgentSessionKey(canonicalKey);
	if (parsed?.agentId) return normalizeAgentId(parsed.agentId);
	return resolveDefaultStoreAgentId(cfg);
}
function resolveStoredSessionKeyForAgentStore(params) {
	const raw = normalizeOptionalString(params.sessionKey) ?? "";
	if (!raw) return raw;
	const lowered = normalizeLowercaseStringOrEmpty(raw);
	if (lowered === "global" || lowered === "unknown") return lowered;
	const key = parseAgentSessionKey(raw) ? raw : canonicalizeSessionKeyForAgent(params.agentId, raw);
	return resolveSessionStoreKey({
		cfg: params.cfg,
		sessionKey: key,
		storeAgentId: params.agentId
	});
}
function resolveStoredSessionOwnerAgentId(params) {
	const canonicalKey = resolveStoredSessionKeyForAgentStore(params);
	if (canonicalKey === "global" || canonicalKey === "unknown") return null;
	return resolveSessionStoreAgentId(params.cfg, canonicalKey);
}
function canonicalizeSpawnedByForAgent(cfg, agentId, spawnedBy) {
	const raw = normalizeOptionalString(spawnedBy) ?? "";
	if (!raw) return;
	const lower = normalizeLowercaseStringOrEmpty(raw);
	if (lower === "global" || lower === "unknown") return lower;
	let result;
	if (lower.startsWith("agent:")) result = lower;
	else result = `agent:${normalizeAgentId(agentId)}:${lower}`;
	const parsed = parseAgentSessionKey(result);
	return canonicalizeMainSessionAlias({
		cfg,
		agentId: parsed?.agentId ? normalizeAgentId(parsed.agentId) : agentId,
		sessionKey: result
	});
}
//#endregion
//#region src/config/sessions/combined-store-gateway.ts
function isStorePathTemplate(store) {
	return typeof store === "string" && store.includes("{agentId}");
}
function mergeSessionEntryIntoCombined(params) {
	const { cfg, combined, entry, agentId, canonicalKey } = params;
	const existing = combined[canonicalKey];
	if (existing && (existing.updatedAt ?? 0) > (entry.updatedAt ?? 0)) {
		const spawnedBy = canonicalizeSpawnedByForAgent(cfg, agentId, existing.spawnedBy ?? entry.spawnedBy);
		combined[canonicalKey] = {
			...entry,
			...existing,
			spawnedBy
		};
		return;
	}
	const spawnedBy = canonicalizeSpawnedByForAgent(cfg, agentId, entry.spawnedBy ?? existing?.spawnedBy);
	if (!existing && entry.spawnedBy === spawnedBy) combined[canonicalKey] = entry;
	else combined[canonicalKey] = {
		...existing,
		...entry,
		spawnedBy
	};
}
function loadCombinedSessionStoreForGateway(cfg, opts = {}) {
	const storeConfig = cfg.session?.store;
	if (storeConfig && !isStorePathTemplate(storeConfig)) {
		const storePath = resolveStorePath(storeConfig);
		const defaultAgentId = normalizeAgentId(resolveDefaultAgentId(cfg));
		const store = loadSessionStore(storePath, { clone: false });
		const combined = {};
		for (const [key, entry] of Object.entries(store)) mergeSessionEntryIntoCombined({
			cfg,
			combined,
			entry,
			agentId: defaultAgentId,
			canonicalKey: resolveStoredSessionKeyForAgentStore({
				cfg,
				agentId: defaultAgentId,
				sessionKey: key
			})
		});
		return {
			storePath,
			store: combined
		};
	}
	const requestedAgentId = typeof opts.agentId === "string" && opts.agentId.trim() ? normalizeAgentId(opts.agentId) : void 0;
	const targets = requestedAgentId ? resolveAgentSessionStoreTargetsSync(cfg, requestedAgentId) : opts.configuredAgentsOnly === true ? resolveSessionStoreTargets(cfg, { allAgents: true }) : resolveAllAgentSessionStoreTargetsSync(cfg);
	const combined = {};
	for (const target of targets) {
		const agentId = target.agentId;
		const storePath = target.storePath;
		const store = loadSessionStore(storePath, { clone: false });
		for (const [key, entry] of Object.entries(store)) mergeSessionEntryIntoCombined({
			cfg,
			combined,
			entry,
			agentId,
			canonicalKey: resolveStoredSessionKeyForAgentStore({
				cfg,
				agentId,
				sessionKey: key
			})
		});
	}
	return {
		storePath: targets.length === 1 ? targets[0].storePath : typeof storeConfig === "string" && storeConfig.trim() ? storeConfig.trim() : "(multiple)",
		store: combined
	};
}
//#endregion
export { resolveSessionStoreKey as a, resolveSessionStoreAgentId as i, canonicalizeSessionKeyForAgent as n, resolveStoredSessionKeyForAgentStore as o, canonicalizeSpawnedByForAgent as r, resolveStoredSessionOwnerAgentId as s, loadCombinedSessionStoreForGateway as t };
