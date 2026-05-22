import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString$1, s as normalizeOptionalLowercaseString } from "./string-coerce-Bje8XVt9.js";
import { v as resolveStateDir } from "./paths-C1_Y0cDn.js";
import { s as resolveRuntimeServiceVersion } from "./version-Ew9InAD4.js";
import { i as readJsonFile, n as createAsyncLock, o as writeJsonAtomic } from "./json-files-BvzDldMA.js";
import { c as normalizeAgentId, m as toAgentRequestSessionKey, o as classifySessionKeyShape, s as isValidAgentId } from "./session-key-BSgfYlBK.js";
import { i as getRuntimeConfig } from "./io-BD1XQ5lD.js";
import { o as isNodeRoleMethod } from "./method-scopes-BHFmOSiN.js";
import { n as pickBestEffortPrimaryLanIPv4 } from "./network-discovery-display-DTuCoqIA.js";
import { c as getAgentRunContext, u as registerAgentRunContext } from "./agent-events-DfaZN9JD.js";
import { t as loadCombinedSessionStoreForGateway } from "./combined-store-gateway-J6vxmiJL.js";
import "./session-utils-l6vzGR0v.js";
import { t as resolvePreferredSessionKeyForSessionIdMatches } from "./session-id-resolution-gc-SIJj7.js";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
//#region src/gateway/control-plane-rate-limit.ts
const CONTROL_PLANE_RATE_LIMIT_MAX_REQUESTS = 3;
const CONTROL_PLANE_RATE_LIMIT_WINDOW_MS = 6e4;
const CONTROL_PLANE_BUCKET_MAX_STALE_MS = 5 * 6e4;
/** Hard cap to prevent memory DoS from rapid unique-key injection (CWE-400). */
const CONTROL_PLANE_BUCKET_MAX_ENTRIES = 1e4;
const controlPlaneBuckets = /* @__PURE__ */ new Map();
function normalizePart(value, fallback) {
	if (typeof value !== "string") return fallback;
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : fallback;
}
function resolveControlPlaneRateLimitKey(client) {
	const deviceId = normalizePart(client?.connect?.device?.id, "unknown-device");
	const clientIp = normalizePart(client?.clientIp, "unknown-ip");
	if (deviceId === "unknown-device" && clientIp === "unknown-ip") {
		const connId = normalizePart(client?.connId, "");
		if (connId) return `${deviceId}|${clientIp}|conn=${connId}`;
	}
	return `${deviceId}|${clientIp}`;
}
function consumeControlPlaneWriteBudget(params) {
	const nowMs = params.nowMs ?? Date.now();
	const key = resolveControlPlaneRateLimitKey(params.client);
	const bucket = controlPlaneBuckets.get(key);
	if (!bucket || nowMs - bucket.windowStartMs >= CONTROL_PLANE_RATE_LIMIT_WINDOW_MS) {
		if (!controlPlaneBuckets.has(key) && controlPlaneBuckets.size >= CONTROL_PLANE_BUCKET_MAX_ENTRIES) {
			const oldest = controlPlaneBuckets.keys().next().value;
			if (oldest !== void 0) controlPlaneBuckets.delete(oldest);
		}
		controlPlaneBuckets.set(key, {
			count: 1,
			windowStartMs: nowMs
		});
		return {
			allowed: true,
			retryAfterMs: 0,
			remaining: CONTROL_PLANE_RATE_LIMIT_MAX_REQUESTS - 1,
			key
		};
	}
	if (bucket.count >= CONTROL_PLANE_RATE_LIMIT_MAX_REQUESTS) return {
		allowed: false,
		retryAfterMs: Math.max(0, bucket.windowStartMs + CONTROL_PLANE_RATE_LIMIT_WINDOW_MS - nowMs),
		remaining: 0,
		key
	};
	bucket.count += 1;
	return {
		allowed: true,
		retryAfterMs: 0,
		remaining: Math.max(0, CONTROL_PLANE_RATE_LIMIT_MAX_REQUESTS - bucket.count),
		key
	};
}
/**
* Remove buckets whose rate-limit window expired more than
* CONTROL_PLANE_BUCKET_MAX_STALE_MS ago.  Called periodically
* by the gateway maintenance timer to prevent unbounded growth.
*/
function pruneStaleControlPlaneBuckets(nowMs = Date.now()) {
	let pruned = 0;
	for (const [key, bucket] of controlPlaneBuckets) if (nowMs - bucket.windowStartMs > CONTROL_PLANE_BUCKET_MAX_STALE_MS) {
		controlPlaneBuckets.delete(key);
		pruned += 1;
	}
	return pruned;
}
//#endregion
//#region src/gateway/role-policy.ts
function parseGatewayRole(roleRaw) {
	if (roleRaw === "operator" || roleRaw === "node") return roleRaw;
	return null;
}
function roleCanSkipDeviceIdentity(role, sharedAuthOk) {
	return role === "operator" && sharedAuthOk;
}
function isRoleAuthorizedForMethod(role, method) {
	if (isNodeRoleMethod(method)) return role === "node";
	return role === "operator";
}
//#endregion
//#region src/infra/voicewake-routing.ts
const MAX_VOICEWAKE_ROUTES = 32;
const MAX_VOICEWAKE_TRIGGER_LENGTH = 64;
const DEFAULT_ROUTING = {
	version: 1,
	defaultTarget: { mode: "current" },
	routes: [],
	updatedAtMs: 0
};
function resolvePath$1(baseDir) {
	const root = baseDir ?? resolveStateDir();
	return path.join(root, "settings", "voicewake-routing.json");
}
function normalizeVoiceWakeTriggerWord(value) {
	return value.toLowerCase().split(/\s+/).map((token) => token.replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, "")).filter(Boolean).join(" ");
}
function normalizeOptionalString(value) {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	return trimmed ? trimmed : void 0;
}
function normalizeRouteTarget(value) {
	if (!value || typeof value !== "object") return null;
	const rec = value;
	if (normalizeOptionalString(rec.mode) === "current") return { mode: "current" };
	const agentId = normalizeOptionalString(rec.agentId);
	const sessionKey = normalizeOptionalString(rec.sessionKey);
	if (agentId && !sessionKey) return { agentId: normalizeAgentId(agentId) };
	if (sessionKey && !agentId) return { sessionKey };
	return null;
}
function normalizeRouteRule(value) {
	if (!value || typeof value !== "object") return null;
	const rec = value;
	const triggerRaw = normalizeOptionalString(rec.trigger);
	if (!triggerRaw) return null;
	const trigger = normalizeVoiceWakeTriggerWord(triggerRaw);
	if (!trigger) return null;
	const target = normalizeRouteTarget(rec.target);
	if (!target) return null;
	return {
		trigger,
		target
	};
}
function isCanonicalAgentSessionKey(value) {
	const trimmed = value.trim();
	if (classifySessionKeyShape(trimmed) !== "agent") return false;
	return !trimmed.split(":").some((part) => part.length === 0);
}
function isPlainObject(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function validateRouteTargetInput(value, label) {
	if (!isPlainObject(value)) return {
		ok: false,
		message: `${label} must be an object`
	};
	const rec = value;
	const mode = normalizeOptionalString(rec.mode);
	const agentId = normalizeOptionalString(rec.agentId);
	const sessionKey = normalizeOptionalString(rec.sessionKey);
	if (mode !== void 0) {
		if (mode !== "current") return {
			ok: false,
			message: `${label}.mode must be "current" when provided`
		};
		if (agentId !== void 0 || sessionKey !== void 0) return {
			ok: false,
			message: `${label} cannot mix mode with agentId or sessionKey`
		};
		return { ok: true };
	}
	if (agentId !== void 0 && sessionKey !== void 0) return {
		ok: false,
		message: `${label} cannot include both agentId and sessionKey`
	};
	if (agentId !== void 0) {
		if (!isValidAgentId(agentId)) return {
			ok: false,
			message: `${label}.agentId must be a valid agent id`
		};
		return { ok: true };
	}
	if (sessionKey !== void 0) {
		if (!isCanonicalAgentSessionKey(sessionKey)) return {
			ok: false,
			message: `${label}.sessionKey must be a canonical agent session key`
		};
		return { ok: true };
	}
	return {
		ok: false,
		message: `${label} must include mode, agentId, or sessionKey`
	};
}
function validateVoiceWakeRoutingConfigInput(input) {
	if (!isPlainObject(input)) return {
		ok: false,
		message: "config must be an object"
	};
	const rec = input;
	if (rec.defaultTarget !== void 0) {
		const validatedDefaultTarget = validateRouteTargetInput(rec.defaultTarget, "config.defaultTarget");
		if (!validatedDefaultTarget.ok) return validatedDefaultTarget;
	}
	if (rec.routes !== void 0 && !Array.isArray(rec.routes)) return {
		ok: false,
		message: "config.routes must be an array"
	};
	if (Array.isArray(rec.routes)) {
		if (rec.routes.length > MAX_VOICEWAKE_ROUTES) return {
			ok: false,
			message: `config.routes must contain at most ${MAX_VOICEWAKE_ROUTES} entries`
		};
		const normalizedTriggers = /* @__PURE__ */ new Map();
		for (const [index, route] of rec.routes.entries()) {
			if (!isPlainObject(route)) return {
				ok: false,
				message: `config.routes[${index}] must be an object`
			};
			const trigger = normalizeOptionalString(route.trigger);
			const normalizedTrigger = trigger ? normalizeVoiceWakeTriggerWord(trigger) : "";
			if (!trigger || !normalizedTrigger) return {
				ok: false,
				message: `config.routes[${index}].trigger must be a non-empty string`
			};
			if (trigger.length > MAX_VOICEWAKE_TRIGGER_LENGTH) return {
				ok: false,
				message: `config.routes[${index}].trigger must be at most ${MAX_VOICEWAKE_TRIGGER_LENGTH} characters`
			};
			const duplicateIndex = normalizedTriggers.get(normalizedTrigger);
			if (duplicateIndex !== void 0) return {
				ok: false,
				message: `config.routes[${index}].trigger duplicates config.routes[${duplicateIndex}].trigger after normalization`
			};
			normalizedTriggers.set(normalizedTrigger, index);
			const validatedTarget = validateRouteTargetInput(route.target, `config.routes[${index}].target`);
			if (!validatedTarget.ok) return validatedTarget;
		}
	}
	return { ok: true };
}
function normalizeVoiceWakeRoutingConfig(input) {
	if (!input || typeof input !== "object") return { ...DEFAULT_ROUTING };
	const rec = input;
	return {
		version: 1,
		defaultTarget: normalizeRouteTarget(rec.defaultTarget) ?? { mode: "current" },
		routes: Array.isArray(rec.routes) ? rec.routes.map((entry) => normalizeRouteRule(entry)).filter((entry) => Boolean(entry)) : [],
		updatedAtMs: typeof rec.updatedAtMs === "number" && Number.isFinite(rec.updatedAtMs) && rec.updatedAtMs > 0 ? Math.floor(rec.updatedAtMs) : 0
	};
}
const withLock$1 = createAsyncLock();
async function loadVoiceWakeRoutingConfig(baseDir) {
	const existing = await readJsonFile(resolvePath$1(baseDir));
	if (!existing) return { ...DEFAULT_ROUTING };
	return normalizeVoiceWakeRoutingConfig(existing);
}
async function setVoiceWakeRoutingConfig(config, baseDir) {
	const normalized = normalizeVoiceWakeRoutingConfig(config);
	const filePath = resolvePath$1(baseDir);
	return await withLock$1(async () => {
		const next = {
			...normalized,
			updatedAtMs: Date.now()
		};
		await writeJsonAtomic(filePath, next);
		return next;
	});
}
function resolveVoiceWakeRouteTarget(routeTarget) {
	if (!routeTarget || "mode" in routeTarget && routeTarget.mode === "current") return { mode: "current" };
	if ("agentId" in routeTarget && routeTarget.agentId) return { agentId: routeTarget.agentId };
	if ("sessionKey" in routeTarget && routeTarget.sessionKey) return { sessionKey: routeTarget.sessionKey };
	return { mode: "current" };
}
function resolveVoiceWakeRouteByTrigger(params) {
	const normalizedTrigger = normalizeOptionalString(params.trigger) ? normalizeVoiceWakeTriggerWord(params.trigger) : "";
	if (normalizedTrigger) {
		const matched = params.config.routes.find((route) => route.trigger === normalizedTrigger);
		if (matched) return resolveVoiceWakeRouteTarget(matched.target);
	}
	return resolveVoiceWakeRouteTarget(params.config.defaultTarget);
}
//#endregion
//#region src/gateway/server-session-key.ts
const RUN_LOOKUP_CACHE_LIMIT = 256;
const RUN_LOOKUP_MISS_TTL_MS = 1e3;
const resolvedSessionKeyByRunId = /* @__PURE__ */ new Map();
function setResolvedSessionKeyCache(runId, sessionKey) {
	if (!runId) return;
	if (!resolvedSessionKeyByRunId.has(runId) && resolvedSessionKeyByRunId.size >= RUN_LOOKUP_CACHE_LIMIT) {
		const oldest = resolvedSessionKeyByRunId.keys().next().value;
		if (oldest) resolvedSessionKeyByRunId.delete(oldest);
	}
	resolvedSessionKeyByRunId.set(runId, {
		sessionKey,
		expiresAt: sessionKey === null ? Date.now() + RUN_LOOKUP_MISS_TTL_MS : null
	});
}
function resolveSessionKeyForRun(runId) {
	const cached = getAgentRunContext(runId)?.sessionKey;
	if (cached) return cached;
	const cachedLookup = resolvedSessionKeyByRunId.get(runId);
	if (cachedLookup !== void 0) {
		if (cachedLookup.sessionKey !== null) return cachedLookup.sessionKey;
		if ((cachedLookup.expiresAt ?? 0) > Date.now()) return;
		resolvedSessionKeyByRunId.delete(runId);
	}
	const { store } = loadCombinedSessionStoreForGateway(getRuntimeConfig());
	const storeKey = resolvePreferredSessionKeyForSessionIdMatches(Object.entries(store).filter((entry) => entry[1]?.sessionId === runId), runId);
	if (storeKey) {
		const sessionKey = toAgentRequestSessionKey(storeKey) ?? storeKey;
		registerAgentRunContext(runId, { sessionKey });
		setResolvedSessionKeyCache(runId, sessionKey);
		return sessionKey;
	}
	setResolvedSessionKeyCache(runId, null);
}
//#endregion
//#region src/infra/voicewake.ts
const DEFAULT_TRIGGERS = [
	"openclaw",
	"claude",
	"computer"
];
function resolvePath(baseDir) {
	const root = baseDir ?? resolveStateDir();
	return path.join(root, "settings", "voicewake.json");
}
function sanitizeTriggers(triggers) {
	const cleaned = (triggers ?? []).map((w) => normalizeOptionalString$1(w) ?? "").filter((w) => w.length > 0);
	return cleaned.length > 0 ? cleaned : DEFAULT_TRIGGERS;
}
const withLock = createAsyncLock();
function defaultVoiceWakeTriggers() {
	return [...DEFAULT_TRIGGERS];
}
async function loadVoiceWakeConfig(baseDir) {
	const existing = await readJsonFile(resolvePath(baseDir));
	if (!existing) return {
		triggers: defaultVoiceWakeTriggers(),
		updatedAtMs: 0
	};
	return {
		triggers: sanitizeTriggers(existing.triggers),
		updatedAtMs: typeof existing.updatedAtMs === "number" && existing.updatedAtMs > 0 ? existing.updatedAtMs : 0
	};
}
async function setVoiceWakeTriggers(triggers, baseDir) {
	const sanitized = sanitizeTriggers(triggers);
	const filePath = resolvePath(baseDir);
	return await withLock(async () => {
		const next = {
			triggers: sanitized,
			updatedAtMs: Date.now()
		};
		await writeJsonAtomic(filePath, next);
		return next;
	});
}
//#endregion
//#region src/gateway/server-utils.ts
function normalizeVoiceWakeTriggers(input) {
	const cleaned = (Array.isArray(input) ? input : []).map((v) => normalizeOptionalString$1(v)).filter((v) => v !== void 0).slice(0, 32).map((v) => v.slice(0, 64));
	return cleaned.length > 0 ? cleaned : defaultVoiceWakeTriggers();
}
function formatError(err) {
	if (err instanceof Error) return err.message;
	if (typeof err === "string") return err;
	const statusValue = err?.status;
	const codeValue = err?.code;
	if (statusValue !== void 0 || codeValue !== void 0) return `status=${typeof statusValue === "string" || typeof statusValue === "number" ? String(statusValue) : "unknown"} code=${typeof codeValue === "string" || typeof codeValue === "number" ? String(codeValue) : "unknown"}`;
	try {
		return JSON.stringify(err, null, 2);
	} catch {
		return String(err);
	}
}
//#endregion
//#region src/gateway/server-methods/nodes-wake-state.ts
const NODE_WAKE_RECONNECT_WAIT_MS = 3e3;
const NODE_WAKE_RECONNECT_RETRY_WAIT_MS = 12e3;
const nodeWakeById = /* @__PURE__ */ new Map();
const nodeWakeNudgeById = /* @__PURE__ */ new Map();
function clearNodeWakeState(nodeId) {
	nodeWakeById.delete(nodeId);
	nodeWakeNudgeById.delete(nodeId);
}
//#endregion
//#region src/infra/system-presence.ts
const entries = /* @__PURE__ */ new Map();
const TTL_MS = 300 * 1e3;
const MAX_ENTRIES = 200;
function normalizePresenceKey(key) {
	return normalizeOptionalLowercaseString(key);
}
function resolvePrimaryIPv4() {
	return pickBestEffortPrimaryLanIPv4() ?? os.hostname();
}
function initSelfPresence() {
	const host = os.hostname();
	const ip = resolvePrimaryIPv4() ?? void 0;
	const version = resolveRuntimeServiceVersion(process.env);
	const modelIdentifier = (() => {
		if (os.platform() === "darwin") {
			const out = normalizeOptionalString$1(spawnSync("sysctl", ["-n", "hw.model"], { encoding: "utf-8" }).stdout) ?? "";
			return out.length > 0 ? out : void 0;
		}
		return os.arch();
	})();
	const macOSVersion = () => {
		const out = normalizeOptionalString$1(spawnSync("sw_vers", ["-productVersion"], { encoding: "utf-8" }).stdout) ?? "";
		return out.length > 0 ? out : os.release();
	};
	const selfEntry = {
		host,
		ip,
		version,
		platform: (() => {
			const p = os.platform();
			const rel = os.release();
			if (p === "darwin") return `macos ${macOSVersion()}`;
			if (p === "win32") return `windows ${rel}`;
			return `${p} ${rel}`;
		})(),
		deviceFamily: (() => {
			const p = os.platform();
			if (p === "darwin") return "Mac";
			if (p === "win32") return "Windows";
			if (p === "linux") return "Linux";
			return p;
		})(),
		modelIdentifier,
		mode: "gateway",
		reason: "self",
		text: `Gateway: ${host}${ip ? ` (${ip})` : ""} · app ${version} · mode gateway · reason self`,
		ts: Date.now()
	};
	const key = normalizeLowercaseStringOrEmpty(host);
	entries.set(key, selfEntry);
}
function ensureSelfPresence() {
	if (entries.size === 0) initSelfPresence();
}
function touchSelfPresence() {
	const key = normalizeLowercaseStringOrEmpty(os.hostname());
	const existing = entries.get(key);
	if (existing) entries.set(key, {
		...existing,
		ts: Date.now()
	});
	else initSelfPresence();
}
initSelfPresence();
function parsePresence(text) {
	const trimmed = text.trim();
	const match = trimmed.match(/Node:\s*([^ (]+)\s*\(([^)]+)\)\s*·\s*app\s*([^·]+?)\s*·\s*last input\s*([0-9]+)s ago\s*·\s*mode\s*([^·]+?)\s*·\s*reason\s*(.+)$/i);
	if (!match) return {
		text: trimmed,
		ts: Date.now()
	};
	const [, host, ip, version, lastInputStr, mode, reasonRaw] = match;
	const lastInputSeconds = Number.parseInt(lastInputStr, 10);
	const reason = reasonRaw.trim();
	return {
		host: host.trim(),
		ip: ip.trim(),
		version: version.trim(),
		lastInputSeconds: Number.isFinite(lastInputSeconds) ? lastInputSeconds : void 0,
		mode: mode.trim(),
		reason,
		text: trimmed,
		ts: Date.now()
	};
}
function mergeStringList(...values) {
	const out = /* @__PURE__ */ new Set();
	for (const list of values) {
		if (!Array.isArray(list)) continue;
		for (const item of list) {
			const trimmed = normalizeOptionalString$1(item) ?? "";
			if (trimmed) out.add(trimmed);
		}
	}
	return out.size > 0 ? [...out] : void 0;
}
function updateSystemPresence(payload) {
	ensureSelfPresence();
	const parsed = parsePresence(payload.text);
	const key = normalizePresenceKey(payload.deviceId) || normalizePresenceKey(payload.instanceId) || normalizePresenceKey(parsed.instanceId) || normalizePresenceKey(parsed.host) || parsed.ip || parsed.text.slice(0, 64) || normalizeLowercaseStringOrEmpty(os.hostname());
	const hadExisting = entries.has(key);
	const existing = entries.get(key) ?? {};
	const merged = {
		...existing,
		...parsed,
		host: payload.host ?? parsed.host ?? existing.host,
		ip: payload.ip ?? parsed.ip ?? existing.ip,
		version: payload.version ?? parsed.version ?? existing.version,
		platform: payload.platform ?? existing.platform,
		deviceFamily: payload.deviceFamily ?? existing.deviceFamily,
		modelIdentifier: payload.modelIdentifier ?? existing.modelIdentifier,
		mode: payload.mode ?? parsed.mode ?? existing.mode,
		lastInputSeconds: payload.lastInputSeconds ?? parsed.lastInputSeconds ?? existing.lastInputSeconds,
		reason: payload.reason ?? parsed.reason ?? existing.reason,
		deviceId: payload.deviceId ?? existing.deviceId,
		roles: mergeStringList(existing.roles, payload.roles),
		scopes: mergeStringList(existing.scopes, payload.scopes),
		instanceId: payload.instanceId ?? parsed.instanceId ?? existing.instanceId,
		text: payload.text || parsed.text || existing.text,
		ts: Date.now()
	};
	entries.set(key, merged);
	const trackKeys = [
		"host",
		"ip",
		"version",
		"mode",
		"reason"
	];
	const changes = {};
	const changedKeys = [];
	for (const k of trackKeys) {
		const prev = existing[k];
		const next = merged[k];
		if (prev !== next) {
			changes[k] = next;
			changedKeys.push(k);
		}
	}
	return {
		key,
		previous: hadExisting ? existing : void 0,
		next: merged,
		changes,
		changedKeys
	};
}
function upsertPresence(key, presence) {
	ensureSelfPresence();
	const normalizedKey = normalizePresenceKey(key) ?? normalizeLowercaseStringOrEmpty(os.hostname());
	const existing = entries.get(normalizedKey) ?? {};
	const roles = mergeStringList(existing.roles, presence.roles);
	const scopes = mergeStringList(existing.scopes, presence.scopes);
	const merged = {
		...existing,
		...presence,
		roles,
		scopes,
		ts: Date.now(),
		text: presence.text || existing.text || `Node: ${presence.host ?? existing.host ?? "unknown"} · mode ${presence.mode ?? existing.mode ?? "unknown"}`
	};
	entries.set(normalizedKey, merged);
}
function listSystemPresence() {
	ensureSelfPresence();
	const now = Date.now();
	for (const [k, v] of entries) if (now - v.ts > TTL_MS) entries.delete(k);
	if (entries.size > MAX_ENTRIES) {
		const sorted = [...entries.entries()].toSorted((a, b) => a[1].ts - b[1].ts);
		const toDrop = entries.size - MAX_ENTRIES;
		for (let i = 0; i < toDrop; i++) entries.delete(sorted[i][0]);
	}
	touchSelfPresence();
	return [...entries.values()].toSorted((a, b) => b.ts - a.ts);
}
//#endregion
//#region src/gateway/server/presence-events.ts
function broadcastPresenceSnapshot(params) {
	const presenceVersion = params.incrementPresenceVersion();
	params.broadcast("presence", { presence: listSystemPresence() }, {
		dropIfSlow: true,
		stateVersion: {
			presence: presenceVersion,
			health: params.getHealthVersion()
		}
	});
	return presenceVersion;
}
//#endregion
export { consumeControlPlaneWriteBudget as C, roleCanSkipDeviceIdentity as S, resolveVoiceWakeRouteByTrigger as _, NODE_WAKE_RECONNECT_RETRY_WAIT_MS as a, isRoleAuthorizedForMethod as b, nodeWakeById as c, normalizeVoiceWakeTriggers as d, loadVoiceWakeConfig as f, normalizeVoiceWakeRoutingConfig as g, loadVoiceWakeRoutingConfig as h, upsertPresence as i, nodeWakeNudgeById as l, resolveSessionKeyForRun as m, listSystemPresence as n, NODE_WAKE_RECONNECT_WAIT_MS as o, setVoiceWakeTriggers as p, updateSystemPresence as r, clearNodeWakeState as s, broadcastPresenceSnapshot as t, formatError as u, setVoiceWakeRoutingConfig as v, pruneStaleControlPlaneBuckets as w, parseGatewayRole as x, validateVoiceWakeRoutingConfigInput as y };
