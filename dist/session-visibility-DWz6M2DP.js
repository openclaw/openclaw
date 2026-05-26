import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { d as resolveAgentIdFromSessionKey } from "./session-key-Bte0mmcq.js";
import { r as callGateway } from "./call-t1U2G3yY.js";
//#region src/plugin-sdk/session-visibility.ts
let callGatewayForListSpawned = callGateway;
/** Test hook: must stay aligned with `sessions-resolution` `testing.setDepsForTest`. */
const sessionVisibilityGatewayTesting = { setCallGatewayForListSpawned(overrides) {
	callGatewayForListSpawned = overrides ?? callGateway;
} };
async function listSpawnedSessionKeys(params) {
	const limit = typeof params.limit === "number" && Number.isFinite(params.limit) ? Math.max(1, Math.floor(params.limit)) : void 0;
	try {
		const list = await callGatewayForListSpawned({
			method: "sessions.list",
			params: {
				includeGlobal: false,
				includeUnknown: false,
				...limit !== void 0 ? { limit } : {},
				spawnedBy: params.requesterSessionKey
			}
		});
		const keys = (Array.isArray(list?.sessions) ? list.sessions : []).map((entry) => normalizeOptionalString(entry?.key) ?? "").filter(Boolean);
		return new Set(keys);
	} catch {
		return /* @__PURE__ */ new Set();
	}
}
function resolveSessionToolsVisibility(cfg) {
	const raw = cfg.tools?.sessions?.visibility;
	const value = normalizeLowercaseStringOrEmpty(raw);
	if (value === "self" || value === "tree" || value === "agent" || value === "all") return value;
	return "tree";
}
function resolveEffectiveSessionToolsVisibility(params) {
	const visibility = resolveSessionToolsVisibility(params.cfg);
	if (!params.sandboxed) return visibility;
	if ((params.cfg.agents?.defaults?.sandbox?.sessionToolsVisibility ?? "spawned") === "spawned" && visibility !== "tree") return "tree";
	return visibility;
}
function resolveSandboxSessionToolsVisibility(cfg) {
	return cfg.agents?.defaults?.sandbox?.sessionToolsVisibility ?? "spawned";
}
function createAgentToAgentPolicy(cfg) {
	const routingA2A = cfg.tools?.agentToAgent;
	const enabled = routingA2A?.enabled === true;
	const allowPatterns = Array.isArray(routingA2A?.allow) ? routingA2A.allow : [];
	const matchesAllow = (agentId) => {
		if (allowPatterns.length === 0) return true;
		return allowPatterns.some((pattern) => {
			const raw = normalizeOptionalString(typeof pattern === "string" ? pattern : String(pattern ?? "")) ?? "";
			if (!raw) return false;
			if (raw === "*") return true;
			if (!raw.includes("*")) return raw === agentId;
			const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			return new RegExp(`^${escaped.replaceAll("\\*", ".*")}$`, "i").test(agentId);
		});
	};
	const isAllowed = (requesterAgentId, targetAgentId) => {
		if (requesterAgentId === targetAgentId) return true;
		if (!enabled) return false;
		return matchesAllow(requesterAgentId) && matchesAllow(targetAgentId);
	};
	return {
		enabled,
		matchesAllow,
		isAllowed
	};
}
function actionPrefix(action) {
	if (action === "history") return "Session history";
	if (action === "send") return "Session send";
	if (action === "status") return "Session status";
	return "Session list";
}
function a2aDisabledMessage(action) {
	if (action === "history") return "Agent-to-agent history is disabled. Set tools.agentToAgent.enabled=true to allow cross-agent access.";
	if (action === "send") return "Agent-to-agent messaging is disabled. Set tools.agentToAgent.enabled=true to allow cross-agent sends.";
	if (action === "status") return "Agent-to-agent status is disabled. Set tools.agentToAgent.enabled=true to allow cross-agent access.";
	return "Agent-to-agent listing is disabled. Set tools.agentToAgent.enabled=true to allow cross-agent visibility.";
}
function a2aDeniedMessage(action) {
	if (action === "history") return "Agent-to-agent history denied by tools.agentToAgent.allow.";
	if (action === "send") return "Agent-to-agent messaging denied by tools.agentToAgent.allow.";
	if (action === "status") return "Agent-to-agent status denied by tools.agentToAgent.allow.";
	return "Agent-to-agent listing denied by tools.agentToAgent.allow.";
}
function crossVisibilityMessage(action) {
	if (action === "history") return "Session history visibility is restricted. Set tools.sessions.visibility=all to allow cross-agent access.";
	if (action === "send") return "Session send visibility is restricted. Set tools.sessions.visibility=all to allow cross-agent access.";
	if (action === "status") return "Session status visibility is restricted. Set tools.sessions.visibility=all to allow cross-agent access.";
	return "Session list visibility is restricted. Set tools.sessions.visibility=all to allow cross-agent access.";
}
function selfVisibilityMessage(action) {
	return `${actionPrefix(action)} visibility is restricted to the current session (tools.sessions.visibility=self).`;
}
function treeVisibilityMessage(action) {
	return `${actionPrefix(action)} visibility is restricted to the current session tree (tools.sessions.visibility=tree).`;
}
function createSessionVisibilityChecker(params) {
	const spawnedKeys = params.spawnedKeys;
	const rowChecker = createSessionVisibilityRowChecker({
		action: params.action,
		requesterSessionKey: params.requesterSessionKey,
		visibility: params.visibility,
		a2aPolicy: params.a2aPolicy
	});
	const check = (targetSessionKey) => {
		const isSpawnedSession = spawnedKeys?.has(targetSessionKey) === true;
		return rowChecker.check({
			key: targetSessionKey,
			spawnedBy: isSpawnedSession ? params.requesterSessionKey : void 0
		});
	};
	return { check };
}
function rowOwnedByRequester(row, requesterSessionKey) {
	return row.ownerSessionKey === requesterSessionKey || row.spawnedBy === requesterSessionKey || row.parentSessionKey === requesterSessionKey;
}
function createSessionVisibilityRowChecker(params) {
	const requesterAgentId = resolveAgentIdFromSessionKey(params.requesterSessionKey);
	const check = (row) => {
		const targetSessionKey = row.key;
		const targetAgentId = row.agentId ?? resolveAgentIdFromSessionKey(targetSessionKey);
		const isRequesterSession = targetSessionKey === params.requesterSessionKey || targetSessionKey === "current";
		const isRequesterOwned = rowOwnedByRequester(row, params.requesterSessionKey);
		if (!isRequesterSession && isRequesterOwned && (params.visibility === "tree" || params.visibility === "all")) return { allowed: true };
		if (targetAgentId !== requesterAgentId) {
			if (params.visibility !== "all") return {
				allowed: false,
				status: "forbidden",
				error: crossVisibilityMessage(params.action)
			};
			if (!params.a2aPolicy.enabled) return {
				allowed: false,
				status: "forbidden",
				error: a2aDisabledMessage(params.action)
			};
			if (!params.a2aPolicy.isAllowed(requesterAgentId, targetAgentId)) return {
				allowed: false,
				status: "forbidden",
				error: a2aDeniedMessage(params.action)
			};
			return { allowed: true };
		}
		if (params.visibility === "self" && !isRequesterSession) return {
			allowed: false,
			status: "forbidden",
			error: selfVisibilityMessage(params.action)
		};
		if (params.visibility === "tree" && !isRequesterSession && !isRequesterOwned) return {
			allowed: false,
			status: "forbidden",
			error: treeVisibilityMessage(params.action)
		};
		return { allowed: true };
	};
	return { check };
}
async function createSessionVisibilityGuard(params) {
	const spawnedKeys = params.action !== "list" && (params.visibility === "tree" || params.visibility === "all") ? await listSpawnedSessionKeys({ requesterSessionKey: params.requesterSessionKey }) : null;
	return createSessionVisibilityChecker({
		action: params.action,
		requesterSessionKey: params.requesterSessionKey,
		visibility: params.visibility,
		a2aPolicy: params.a2aPolicy,
		spawnedKeys
	});
}
//#endregion
export { listSpawnedSessionKeys as a, resolveSessionToolsVisibility as c, createSessionVisibilityRowChecker as i, sessionVisibilityGatewayTesting as l, createSessionVisibilityChecker as n, resolveEffectiveSessionToolsVisibility as o, createSessionVisibilityGuard as r, resolveSandboxSessionToolsVisibility as s, createAgentToAgentPolicy as t };
