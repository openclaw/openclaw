import { c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import "./agent-scope-CtLXGcWm.js";
import { a as isSubagentSessionKey, c as parseAgentSessionKey, n as isAcpSessionKey, t as getSubagentDepth } from "./session-key-utils-Ce_xWkNq.js";
import { c as resolveDefaultAgentId } from "./agent-scope-config-CMp71_27.js";
import { t as parseJsonWithJson5Fallback } from "./parse-json-compat-c3237LfJ.js";
import { u as resolveStorePath } from "./paths-Bg3PO6Gj.js";
import { t as loadSessionStore } from "./store-load-z4thf6ld.js";
import "./sessions-CQHHcgC_.js";
import { m as normalizeToolName } from "./tool-policy-COX5DaEj.js";
import { n as isToolAllowedByPolicyName } from "./tool-policy-match-C9WqMgmG.js";
import fs from "node:fs";
//#region src/agents/inherited-tool-deny.ts
const ACP_UNSUPPORTED_INHERITED_TOOL_DENY = [
	"apply_patch",
	"edit",
	"exec",
	"fs_delete",
	"fs_move",
	"fs_write",
	"process",
	"read",
	"shell",
	"spawn",
	"write"
];
const ACP_REQUIRED_INHERITED_TOOL_ALLOW = [
	"apply_patch",
	"edit",
	"exec",
	"process",
	"read",
	"write"
];
function normalizeInheritedToolDenylist(value) {
	if (!Array.isArray(value)) return [];
	const seen = /* @__PURE__ */ new Set();
	const result = [];
	for (const entry of value) {
		if (typeof entry !== "string") continue;
		const normalized = normalizeToolName(entry);
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		result.push(normalized);
	}
	return result;
}
function inheritedToolDenyPatch(value) {
	const inheritedToolDeny = normalizeInheritedToolDenylist(value);
	return inheritedToolDeny.length > 0 ? { inheritedToolDeny } : {};
}
function normalizeInheritedToolAllowlist(value) {
	return normalizeInheritedToolDenylist(value);
}
function inheritedToolAllowPatch(value) {
	const inheritedToolAllow = normalizeInheritedToolAllowlist(value);
	return inheritedToolAllow.length > 0 ? { inheritedToolAllow } : {};
}
function findAcpUnsupportedInheritedToolDeny(value) {
	const inheritedToolDeny = normalizeInheritedToolDenylist(value);
	if (inheritedToolDeny.length === 0) return;
	return ACP_UNSUPPORTED_INHERITED_TOOL_DENY.find((toolName) => !isToolAllowedByPolicyName(toolName, { deny: inheritedToolDeny }));
}
function findAcpUnsupportedInheritedToolAllow(value) {
	const inheritedToolAllow = normalizeInheritedToolAllowlist(value);
	if (inheritedToolAllow.length === 0) return;
	return ACP_REQUIRED_INHERITED_TOOL_ALLOW.find((toolName) => !isToolAllowedByPolicyName(toolName, { allow: inheritedToolAllow }));
}
function formatAcpInheritedToolDenyError(toolName) {
	return `runtime="acp" is unavailable because the requester denies ${toolName}. Use runtime="subagent".`;
}
function formatAcpInheritedToolAllowError(toolName) {
	return `runtime="acp" is unavailable because the requester does not allow ${toolName}. Use runtime="subagent".`;
}
//#endregion
//#region src/agents/subagent-session-key.ts
const normalizeSubagentSessionKey = normalizeOptionalString;
//#endregion
//#region src/agents/subagent-depth.ts
function normalizeSpawnDepth(value) {
	if (typeof value === "number") return Number.isInteger(value) && value >= 0 ? value : void 0;
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (!trimmed) return;
		const numeric = Number(trimmed);
		return Number.isInteger(numeric) && numeric >= 0 ? numeric : void 0;
	}
}
function readSessionStore$1(storePath) {
	try {
		const parsed = parseJsonWithJson5Fallback(fs.readFileSync(storePath, "utf-8"));
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
	} catch {}
	return {};
}
function buildKeyCandidates(rawKey, cfg) {
	if (!cfg) return [rawKey];
	if (rawKey === "global" || rawKey === "unknown") return [rawKey];
	if (parseAgentSessionKey(rawKey)) return [rawKey];
	const prefixed = `agent:${resolveDefaultAgentId(cfg)}:${rawKey}`;
	return prefixed === rawKey ? [rawKey] : [rawKey, prefixed];
}
function findEntryBySessionId$1(store, sessionId) {
	const normalizedSessionId = normalizeSubagentSessionKey(sessionId);
	if (!normalizedSessionId) return;
	for (const entry of Object.values(store)) {
		const candidateSessionId = normalizeSubagentSessionKey(entry?.sessionId);
		if (candidateSessionId && candidateSessionId === normalizedSessionId) return entry;
	}
}
function resolveEntryForSessionKey(params) {
	const candidates = buildKeyCandidates(params.sessionKey, params.cfg);
	if (params.store) {
		for (const key of candidates) {
			const entry = params.store[key];
			if (entry) return entry;
		}
		return findEntryBySessionId$1(params.store, params.sessionKey);
	}
	if (!params.cfg) return;
	for (const key of candidates) {
		const parsed = parseAgentSessionKey(key);
		if (!parsed?.agentId) continue;
		const storePath = resolveStorePath(params.cfg.session?.store, { agentId: parsed.agentId });
		let store = params.cache.get(storePath);
		if (!store) {
			store = readSessionStore$1(storePath);
			params.cache.set(storePath, store);
		}
		const entry = store[key] ?? findEntryBySessionId$1(store, params.sessionKey);
		if (entry) return entry;
	}
}
function getSubagentDepthFromSessionStore(sessionKey, opts) {
	const raw = (sessionKey ?? "").trim();
	const fallbackDepth = getSubagentDepth(raw);
	if (!raw) return fallbackDepth;
	const cache = /* @__PURE__ */ new Map();
	const visited = /* @__PURE__ */ new Set();
	const depthFromStore = (key) => {
		const normalizedKey = normalizeSubagentSessionKey(key);
		if (!normalizedKey) return;
		if (visited.has(normalizedKey)) return;
		visited.add(normalizedKey);
		const entry = resolveEntryForSessionKey({
			sessionKey: normalizedKey,
			cfg: opts?.cfg,
			store: opts?.store,
			cache
		});
		const storedDepth = normalizeSpawnDepth(entry?.spawnDepth);
		if (storedDepth !== void 0) return storedDepth;
		const spawnedBy = normalizeSubagentSessionKey(entry?.spawnedBy);
		if (!spawnedBy) return;
		const parentDepth = depthFromStore(spawnedBy);
		if (parentDepth !== void 0) return parentDepth + 1;
		return getSubagentDepth(spawnedBy) + 1;
	};
	return depthFromStore(raw) ?? fallbackDepth;
}
//#endregion
//#region src/agents/subagent-capabilities.ts
const SUBAGENT_SESSION_ROLES = [
	"main",
	"orchestrator",
	"leaf"
];
const SUBAGENT_CONTROL_SCOPES = ["children", "none"];
function normalizeSubagentRole(value) {
	const trimmed = normalizeOptionalLowercaseString(value);
	return SUBAGENT_SESSION_ROLES.find((entry) => entry === trimmed);
}
function normalizeSubagentControlScope(value) {
	const trimmed = normalizeOptionalLowercaseString(value);
	return SUBAGENT_CONTROL_SCOPES.find((entry) => entry === trimmed);
}
function shouldInspectStoredSubagentEnvelope(sessionKey) {
	return isSubagentSessionKey(sessionKey) || isAcpSessionKey(sessionKey);
}
function isSameAgentSessionStore(leftSessionKey, rightSessionKey) {
	const leftAgentId = normalizeOptionalLowercaseString(parseAgentSessionKey(leftSessionKey)?.agentId);
	const rightAgentId = normalizeOptionalLowercaseString(parseAgentSessionKey(rightSessionKey)?.agentId);
	return Boolean(leftAgentId) && leftAgentId === rightAgentId;
}
function readSessionStore(storePath) {
	try {
		return loadSessionStore(storePath);
	} catch {
		return {};
	}
}
function findEntryBySessionId(store, sessionId) {
	const normalizedSessionId = normalizeSubagentSessionKey(sessionId);
	if (!normalizedSessionId) return;
	for (const entry of Object.values(store)) if (normalizeSubagentSessionKey(entry?.sessionId) === normalizedSessionId) return entry;
}
function resolveSessionCapabilityEntry(params) {
	if (params.store) return params.store[params.sessionKey] ?? findEntryBySessionId(params.store, params.sessionKey);
	if (!params.cfg) return;
	const parsed = parseAgentSessionKey(params.sessionKey);
	if (!parsed?.agentId) return;
	const store = readSessionStore(resolveStorePath(params.cfg.session?.store, { agentId: parsed.agentId }));
	return store[params.sessionKey] ?? findEntryBySessionId(store, params.sessionKey);
}
function resolveSubagentCapabilityStore(sessionKey, opts) {
	const normalizedSessionKey = normalizeSubagentSessionKey(sessionKey);
	if (!normalizedSessionKey) return opts?.store;
	if (opts?.store) return opts.store;
	if (!opts?.cfg || !shouldInspectStoredSubagentEnvelope(normalizedSessionKey)) return;
	const parsed = parseAgentSessionKey(normalizedSessionKey);
	if (!parsed?.agentId) return;
	return readSessionStore(resolveStorePath(opts.cfg.session?.store, { agentId: parsed.agentId }));
}
function resolveSubagentRoleForDepth(params) {
	const depth = Number.isInteger(params.depth) ? Math.max(0, params.depth) : 0;
	const maxSpawnDepth = typeof params.maxSpawnDepth === "number" && Number.isFinite(params.maxSpawnDepth) ? Math.max(1, Math.floor(params.maxSpawnDepth)) : 1;
	if (depth <= 0) return "main";
	return depth < maxSpawnDepth ? "orchestrator" : "leaf";
}
function resolveSubagentControlScopeForRole(role) {
	return role === "leaf" ? "none" : "children";
}
function resolveSubagentCapabilities(params) {
	const role = resolveSubagentRoleForDepth(params);
	const controlScope = resolveSubagentControlScopeForRole(role);
	return {
		depth: Math.max(0, Math.floor(params.depth)),
		role,
		controlScope,
		canSpawn: role === "main" || role === "orchestrator",
		canControlChildren: controlScope === "children"
	};
}
function isStoredSubagentEnvelopeSession(params, visited = /* @__PURE__ */ new Set()) {
	const normalizedSessionKey = normalizeSubagentSessionKey(params.sessionKey);
	if (!normalizedSessionKey || visited.has(normalizedSessionKey)) return false;
	visited.add(normalizedSessionKey);
	if (isSubagentSessionKey(normalizedSessionKey)) return true;
	if (!isAcpSessionKey(normalizedSessionKey)) return false;
	const entry = params.entry ?? resolveSessionCapabilityEntry({
		sessionKey: normalizedSessionKey,
		cfg: params.cfg,
		store: params.store
	});
	if (normalizeSubagentRole(entry?.subagentRole) || normalizeSubagentControlScope(entry?.subagentControlScope)) return true;
	const spawnedBy = normalizeSubagentSessionKey(entry?.spawnedBy);
	if (!spawnedBy) return false;
	const parentStore = isSameAgentSessionStore(normalizedSessionKey, spawnedBy) ? params.store : void 0;
	return isStoredSubagentEnvelopeSession({
		sessionKey: spawnedBy,
		cfg: params.cfg,
		store: parentStore
	}, visited);
}
function isSubagentEnvelopeSession(sessionKey, opts) {
	const normalizedSessionKey = normalizeSubagentSessionKey(sessionKey);
	if (!normalizedSessionKey) return false;
	if (isSubagentSessionKey(normalizedSessionKey)) return true;
	if (!isAcpSessionKey(normalizedSessionKey)) return false;
	const store = resolveSubagentCapabilityStore(normalizedSessionKey, opts);
	return isStoredSubagentEnvelopeSession({
		sessionKey: normalizedSessionKey,
		cfg: opts?.cfg,
		store,
		entry: opts?.entry
	});
}
function resolveStoredSubagentCapabilities(sessionKey, opts) {
	const normalizedSessionKey = normalizeSubagentSessionKey(sessionKey);
	const maxSpawnDepth = opts?.cfg?.agents?.defaults?.subagents?.maxSpawnDepth ?? 1;
	if (!normalizedSessionKey) return resolveSubagentCapabilities({
		depth: 0,
		maxSpawnDepth
	});
	if (!shouldInspectStoredSubagentEnvelope(normalizedSessionKey)) return resolveSubagentCapabilities({
		depth: getSubagentDepthFromSessionStore(normalizedSessionKey, {
			cfg: opts?.cfg,
			store: opts?.store
		}),
		maxSpawnDepth
	});
	const store = resolveSubagentCapabilityStore(normalizedSessionKey, opts);
	const entry = normalizedSessionKey ? resolveSessionCapabilityEntry({
		sessionKey: normalizedSessionKey,
		cfg: opts?.cfg,
		store
	}) : void 0;
	const depthStore = opts?.cfg && typeof entry?.spawnDepth !== "number" ? void 0 : store;
	const depth = getSubagentDepthFromSessionStore(normalizedSessionKey, {
		cfg: opts?.cfg,
		store: depthStore
	});
	if (!isSubagentEnvelopeSession(normalizedSessionKey, {
		...opts,
		store,
		entry
	})) return resolveSubagentCapabilities({
		depth,
		maxSpawnDepth
	});
	const storedRole = normalizeSubagentRole(entry?.subagentRole);
	const storedControlScope = normalizeSubagentControlScope(entry?.subagentControlScope);
	const fallback = resolveSubagentCapabilities({
		depth,
		maxSpawnDepth
	});
	const role = storedRole ?? fallback.role;
	const controlScope = storedControlScope ?? resolveSubagentControlScopeForRole(role);
	return {
		depth,
		role,
		controlScope,
		canSpawn: role === "main" || role === "orchestrator",
		canControlChildren: controlScope === "children"
	};
}
function resolveStoredSubagentInheritedToolDenylist(sessionKey, opts) {
	const normalizedSessionKey = normalizeSubagentSessionKey(sessionKey);
	if (!normalizedSessionKey || !shouldInspectStoredSubagentEnvelope(normalizedSessionKey)) return [];
	const store = resolveSubagentCapabilityStore(normalizedSessionKey, opts);
	return normalizeInheritedToolDenylist(resolveSessionCapabilityEntry({
		sessionKey: normalizedSessionKey,
		cfg: opts?.cfg,
		store
	})?.inheritedToolDeny);
}
function resolveStoredSubagentInheritedToolAllowlist(sessionKey, opts) {
	const normalizedSessionKey = normalizeSubagentSessionKey(sessionKey);
	if (!normalizedSessionKey || !shouldInspectStoredSubagentEnvelope(normalizedSessionKey)) return [];
	const store = resolveSubagentCapabilityStore(normalizedSessionKey, opts);
	return normalizeInheritedToolAllowlist(resolveSessionCapabilityEntry({
		sessionKey: normalizedSessionKey,
		cfg: opts?.cfg,
		store
	})?.inheritedToolAllow);
}
//#endregion
export { resolveSubagentCapabilities as a, findAcpUnsupportedInheritedToolAllow as c, formatAcpInheritedToolDenyError as d, inheritedToolAllowPatch as f, normalizeInheritedToolDenylist as h, resolveStoredSubagentInheritedToolDenylist as i, findAcpUnsupportedInheritedToolDeny as l, normalizeInheritedToolAllowlist as m, resolveStoredSubagentCapabilities as n, resolveSubagentCapabilityStore as o, inheritedToolDenyPatch as p, resolveStoredSubagentInheritedToolAllowlist as r, getSubagentDepthFromSessionStore as s, isSubagentEnvelopeSession as t, formatAcpInheritedToolAllowError as u };
