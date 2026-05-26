import { y as resolveStateDir } from "./paths-Cw7f9XhU.js";
import { t as createAsyncLock } from "./async-lock-CaiUOILd.js";
import { c as isValidAgentId, l as normalizeAgentId, o as classifySessionKeyShape } from "./session-key-Bte0mmcq.js";
import { m as writeJson, o as tryReadJson } from "./json-files-C2hqjU--.js";
import { o as isNodeRoleMethod } from "./method-scopes-D4RcH8qD.js";
import path from "node:path";
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
function resolvePath(baseDir) {
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
const withLock = createAsyncLock();
async function loadVoiceWakeRoutingConfig(baseDir) {
	const existing = await tryReadJson(resolvePath(baseDir));
	if (!existing) return { ...DEFAULT_ROUTING };
	return normalizeVoiceWakeRoutingConfig(existing);
}
async function setVoiceWakeRoutingConfig(config, baseDir) {
	const normalized = normalizeVoiceWakeRoutingConfig(config);
	const filePath = resolvePath(baseDir);
	return await withLock(async () => {
		const next = {
			...normalized,
			updatedAtMs: Date.now()
		};
		await writeJson(filePath, next);
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
export { validateVoiceWakeRoutingConfigInput as a, roleCanSkipDeviceIdentity as c, setVoiceWakeRoutingConfig as i, normalizeVoiceWakeRoutingConfig as n, isRoleAuthorizedForMethod as o, resolveVoiceWakeRouteByTrigger as r, parseGatewayRole as s, loadVoiceWakeRoutingConfig as t };
