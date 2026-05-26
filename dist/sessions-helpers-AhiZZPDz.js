import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { a as isSubagentSessionKey, n as isAcpSessionKey } from "./session-key-utils-Ce_xWkNq.js";
import { u as normalizeMainKey } from "./session-key-Bte0mmcq.js";
import { i as getRuntimeConfig } from "./io-DoswVvYe.js";
import "./config-B6Oplu5W.js";
import { n as GATEWAY_CLIENT_IDS, o as normalizeGatewayClientId } from "./client-info-BVWE_ra1.js";
import { r as callGateway } from "./call-t1U2G3yY.js";
import { a as listSpawnedSessionKeys, s as resolveSandboxSessionToolsVisibility } from "./session-visibility-DWz6M2DP.js";
import { n as looksLikeSessionId } from "./session-id-MQsocdDH.js";
import "./chat-history-text-BaMeG8tt.js";
//#region src/agents/tools/sessions-resolution.ts
const defaultSessionsResolutionDeps = { callGateway };
const CURRENT_SESSION_CLIENT_ALIAS_IDS = new Set([
	GATEWAY_CLIENT_IDS.TUI,
	GATEWAY_CLIENT_IDS.CLI,
	GATEWAY_CLIENT_IDS.WEBCHAT_UI,
	GATEWAY_CLIENT_IDS.CONTROL_UI,
	GATEWAY_CLIENT_IDS.MACOS_APP,
	GATEWAY_CLIENT_IDS.IOS_APP,
	GATEWAY_CLIENT_IDS.ANDROID_APP
]);
let sessionsResolutionDeps = defaultSessionsResolutionDeps;
function resolveMainSessionAlias(cfg) {
	const mainKey = normalizeMainKey(cfg.session?.mainKey);
	const scope = cfg.session?.scope ?? "per-sender";
	return {
		mainKey,
		alias: scope === "global" ? "global" : mainKey,
		scope
	};
}
function resolveDisplaySessionKey(params) {
	if (params.key === params.alias) return "main";
	if (params.key === params.mainKey) return "main";
	return params.key;
}
function resolveInternalSessionKey(params) {
	if (params.key === "current") return params.requesterInternalKey ?? params.key;
	if (params.key === "main") return params.alias;
	return params.key;
}
function resolveCurrentSessionClientAlias(params) {
	const requesterKey = normalizeOptionalString(params.requesterInternalKey);
	if (!requesterKey) return;
	const clientId = normalizeGatewayClientId(params.key);
	if (!clientId || !CURRENT_SESSION_CLIENT_ALIAS_IDS.has(clientId)) return;
	return requesterKey;
}
async function isRequesterSpawnedSessionVisible(params) {
	if (params.requesterSessionKey === params.targetSessionKey) return true;
	try {
		const resolved = await sessionsResolutionDeps.callGateway({
			method: "sessions.resolve",
			params: {
				key: params.targetSessionKey,
				spawnedBy: params.requesterSessionKey
			}
		});
		if (typeof resolved?.key === "string" && resolved.key.trim() === params.targetSessionKey) return true;
	} catch {}
	return (await listSpawnedSessionKeys({
		requesterSessionKey: params.requesterSessionKey,
		limit: params.limit
	})).has(params.targetSessionKey);
}
function shouldVerifyRequesterSpawnedSessionVisibility(params) {
	return params.restrictToSpawned && !params.resolvedViaSessionId && params.requesterSessionKey !== params.targetSessionKey;
}
async function isResolvedSessionVisibleToRequester(params) {
	if (!shouldVerifyRequesterSpawnedSessionVisibility({
		requesterSessionKey: params.requesterSessionKey,
		targetSessionKey: params.targetSessionKey,
		restrictToSpawned: params.restrictToSpawned,
		resolvedViaSessionId: params.resolvedViaSessionId
	})) return true;
	return await isRequesterSpawnedSessionVisible({
		requesterSessionKey: params.requesterSessionKey,
		targetSessionKey: params.targetSessionKey,
		limit: params.limit
	});
}
function looksLikeSessionKey(value) {
	const raw = normalizeOptionalString(value) ?? "";
	if (!raw) return false;
	if (raw === "main" || raw === "global" || raw === "unknown" || raw === "current") return true;
	if (isAcpSessionKey(raw)) return true;
	if (raw.startsWith("agent:")) return true;
	if (raw.startsWith("cron:") || raw.startsWith("hook:")) return true;
	if (raw.startsWith("node-") || raw.startsWith("node:")) return true;
	if (raw.includes(":group:") || raw.includes(":channel:")) return true;
	return false;
}
function shouldResolveSessionIdInput(value) {
	return looksLikeSessionId(value) || !looksLikeSessionKey(value);
}
function buildResolvedSessionReference(params) {
	return {
		ok: true,
		key: params.key,
		displayKey: resolveDisplaySessionKey({
			key: params.key,
			alias: params.alias,
			mainKey: params.mainKey
		}),
		resolvedViaSessionId: params.resolvedViaSessionId
	};
}
function buildSessionIdResolveParams(params) {
	return {
		sessionId: params.sessionId,
		spawnedBy: params.restrictToSpawned ? params.requesterInternalKey : void 0,
		includeGlobal: !params.restrictToSpawned,
		includeUnknown: !params.restrictToSpawned
	};
}
async function callGatewayResolveSessionId(params) {
	const key = normalizeOptionalString((await sessionsResolutionDeps.callGateway({
		method: "sessions.resolve",
		params: buildSessionIdResolveParams(params)
	}))?.key) ?? "";
	if (!key) throw new Error(`Session not found: ${params.sessionId} (use the full sessionKey from sessions_list)`);
	return key;
}
async function resolveSessionKeyFromSessionId(params) {
	try {
		return buildResolvedSessionReference({
			key: await callGatewayResolveSessionId(params),
			alias: params.alias,
			mainKey: params.mainKey,
			resolvedViaSessionId: true
		});
	} catch (err) {
		if (params.restrictToSpawned) return {
			ok: false,
			status: "forbidden",
			error: `Session not visible from this sandboxed agent session: ${params.sessionId}`
		};
		return {
			ok: false,
			status: "error",
			error: formatErrorMessage(err) || `Session not found: ${params.sessionId} (use the full sessionKey from sessions_list)`
		};
	}
}
async function resolveSessionKeyFromKey(params) {
	try {
		const key = normalizeOptionalString((await sessionsResolutionDeps.callGateway({
			method: "sessions.resolve",
			params: {
				key: params.key,
				spawnedBy: params.restrictToSpawned ? params.requesterInternalKey : void 0
			}
		}))?.key) ?? "";
		if (!key) return null;
		return buildResolvedSessionReference({
			key,
			alias: params.alias,
			mainKey: params.mainKey,
			resolvedViaSessionId: false
		});
	} catch {
		return null;
	}
}
async function tryResolveSessionKeyFromSessionId(params) {
	try {
		return buildResolvedSessionReference({
			key: await callGatewayResolveSessionId(params),
			alias: params.alias,
			mainKey: params.mainKey,
			resolvedViaSessionId: true
		});
	} catch {
		return null;
	}
}
async function resolveSessionReferenceByKeyOrSessionId(params) {
	if (!params.skipKeyLookup) {
		const resolvedByKey = await resolveSessionKeyFromKey({
			key: params.raw,
			alias: params.alias,
			mainKey: params.mainKey,
			requesterInternalKey: params.requesterInternalKey,
			restrictToSpawned: params.restrictToSpawned
		});
		if (resolvedByKey) return resolvedByKey;
	}
	if (!(params.forceSessionIdLookup || shouldResolveSessionIdInput(params.raw))) return null;
	if (params.allowUnresolvedSessionId) return await tryResolveSessionKeyFromSessionId({
		sessionId: params.raw,
		alias: params.alias,
		mainKey: params.mainKey,
		requesterInternalKey: params.requesterInternalKey,
		restrictToSpawned: params.restrictToSpawned
	});
	return await resolveSessionKeyFromSessionId({
		sessionId: params.raw,
		alias: params.alias,
		mainKey: params.mainKey,
		requesterInternalKey: params.requesterInternalKey,
		restrictToSpawned: params.restrictToSpawned
	});
}
async function resolveSessionReference(params) {
	const rawInput = resolveCurrentSessionClientAlias({
		key: params.sessionKey,
		requesterInternalKey: params.requesterInternalKey
	}) ?? params.sessionKey.trim();
	if (rawInput === "current") {
		const resolvedCurrent = await resolveSessionReferenceByKeyOrSessionId({
			raw: rawInput,
			alias: params.alias,
			mainKey: params.mainKey,
			requesterInternalKey: params.requesterInternalKey,
			restrictToSpawned: params.restrictToSpawned,
			allowUnresolvedSessionId: true,
			skipKeyLookup: params.restrictToSpawned,
			forceSessionIdLookup: true
		});
		if (resolvedCurrent) return resolvedCurrent;
	}
	const raw = rawInput === "current" && params.requesterInternalKey ? params.requesterInternalKey : rawInput;
	if (shouldResolveSessionIdInput(raw)) {
		const resolvedByGateway = await resolveSessionReferenceByKeyOrSessionId({
			raw,
			alias: params.alias,
			mainKey: params.mainKey,
			requesterInternalKey: params.requesterInternalKey,
			restrictToSpawned: params.restrictToSpawned,
			allowUnresolvedSessionId: false
		});
		if (resolvedByGateway) return resolvedByGateway;
	}
	const resolvedKey = resolveInternalSessionKey({
		key: raw,
		alias: params.alias,
		mainKey: params.mainKey,
		requesterInternalKey: params.requesterInternalKey
	});
	return {
		ok: true,
		key: resolvedKey,
		displayKey: resolveDisplaySessionKey({
			key: resolvedKey,
			alias: params.alias,
			mainKey: params.mainKey
		}),
		resolvedViaSessionId: false
	};
}
async function resolveVisibleSessionReference(params) {
	const resolvedKey = params.resolvedSession.key;
	const displayKey = params.resolvedSession.displayKey;
	if (!await isResolvedSessionVisibleToRequester({
		requesterSessionKey: params.requesterSessionKey,
		targetSessionKey: resolvedKey,
		restrictToSpawned: params.restrictToSpawned,
		resolvedViaSessionId: params.resolvedSession.resolvedViaSessionId
	})) return {
		ok: false,
		status: "forbidden",
		error: `Session not visible from this sandboxed agent session: ${params.visibilitySessionKey}`,
		displayKey
	};
	return {
		ok: true,
		key: resolvedKey,
		displayKey
	};
}
//#endregion
//#region src/agents/tools/sessions-access.ts
function resolveSandboxedSessionToolContext(params) {
	const { mainKey, alias } = resolveMainSessionAlias(params.cfg);
	const visibility = resolveSandboxSessionToolsVisibility(params.cfg);
	const requesterSessionKey = normalizeOptionalString(params.agentSessionKey);
	const requesterInternalKey = requesterSessionKey ? resolveInternalSessionKey({
		key: requesterSessionKey,
		alias,
		mainKey
	}) : void 0;
	return {
		mainKey,
		alias,
		visibility,
		requesterInternalKey,
		effectiveRequesterKey: requesterInternalKey ?? alias,
		restrictToSpawned: params.sandboxed === true && visibility === "spawned" && !!requesterInternalKey && !isSubagentSessionKey(requesterInternalKey)
	};
}
//#endregion
//#region src/agents/tools/sessions-helpers.ts
function resolveSessionToolContext(opts) {
	const cfg = opts?.config ?? getRuntimeConfig();
	return {
		cfg,
		...resolveSandboxedSessionToolContext({
			cfg,
			agentSessionKey: opts?.agentSessionKey,
			sandboxed: opts?.sandboxed
		})
	};
}
function classifySessionKind(params) {
	const key = params.key;
	if (key === params.alias || key === params.mainKey) return "main";
	if (key.startsWith("cron:")) return "cron";
	if (key.startsWith("hook:")) return "hook";
	if (key.startsWith("node-") || key.startsWith("node:")) return "node";
	if (params.gatewayKind === "group") return "group";
	if (key.includes(":group:") || key.includes(":channel:")) return "group";
	return "other";
}
function deriveChannel(params) {
	if (params.kind === "cron" || params.kind === "hook" || params.kind === "node") return "internal";
	const channel = normalizeOptionalString(params.channel ?? void 0);
	if (channel) return channel;
	const lastChannel = normalizeOptionalString(params.lastChannel ?? void 0);
	if (lastChannel) return lastChannel;
	const parts = params.key.split(":").filter(Boolean);
	if (parts.length >= 3 && (parts[1] === "group" || parts[1] === "channel")) return parts[0];
	return "unknown";
}
//#endregion
export { resolveCurrentSessionClientAlias as a, resolveMainSessionAlias as c, shouldResolveSessionIdInput as d, resolveSandboxedSessionToolContext as i, resolveSessionReference as l, deriveChannel as n, resolveDisplaySessionKey as o, resolveSessionToolContext as r, resolveInternalSessionKey as s, classifySessionKind as t, resolveVisibleSessionReference as u };
