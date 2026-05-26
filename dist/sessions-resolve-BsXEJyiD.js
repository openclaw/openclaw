import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { Ni as ErrorCodes, Pi as errorShape, xo as parseSessionLabel } from "./protocol-DiXjp30g.js";
import { t as loadCombinedSessionStoreForGateway } from "./combined-store-gateway-NV2GSCR6.js";
import { t as loadSessionStore } from "./store-load-z4thf6ld.js";
import { u as updateSessionStore } from "./store-BmtchQvp.js";
import "./sessions-CQHHcgC_.js";
import { a as listSessionsFromStore, d as resolveDeletedAgentIdFromSessionKey, l as migrateAndPruneGatewaySessionStoreKey, m as resolveGatewaySessionStoreTarget, r as filterAndSortSessionEntries } from "./session-utils-CRKr-5AU.js";
import { n as resolveSessionIdMatchSelection } from "./session-id-resolution-CQPMwA0q.js";
//#region src/gateway/sessions-resolve.ts
function resolveSessionVisibilityFilterOptions(p) {
	return {
		includeGlobal: p.includeGlobal === true,
		includeUnknown: p.includeUnknown === true,
		spawnedBy: p.spawnedBy,
		agentId: p.agentId
	};
}
function noSessionFoundResult(key) {
	return {
		ok: false,
		error: errorShape(ErrorCodes.INVALID_REQUEST, `No session found: ${key}`)
	};
}
/** Rejects sessions whose owning agent no longer exists in config (#65524). */
function validateSessionAgentExists(cfg, key) {
	const deletedAgentId = resolveDeletedAgentIdFromSessionKey(cfg, key);
	if (deletedAgentId === null) return null;
	return {
		ok: false,
		error: errorShape(ErrorCodes.INVALID_REQUEST, `Agent "${deletedAgentId}" no longer exists in configuration`)
	};
}
function isResolvedSessionKeyVisible(params) {
	if (typeof params.p.spawnedBy !== "string" || params.p.spawnedBy.trim().length === 0) return true;
	return filterAndSortSessionEntries({
		cfg: params.cfg,
		store: params.store,
		now: Date.now(),
		opts: resolveSessionVisibilityFilterOptions(params.p)
	}).some(([key]) => key === params.key);
}
function findVisibleSessionIdMatches(params) {
	const now = Date.now();
	return filterAndSortSessionEntries({
		cfg: params.cfg,
		store: params.store,
		now,
		opts: resolveSessionVisibilityFilterOptions(params.p)
	}).filter(([key, entry]) => entry?.sessionId === params.sessionId || key === params.sessionId);
}
async function resolveSessionKeyFromResolveParams(params) {
	const { cfg, p } = params;
	const key = normalizeOptionalString(p.key) ?? "";
	const hasKey = key.length > 0;
	const sessionId = normalizeOptionalString(p.sessionId) ?? "";
	const hasSessionId = sessionId.length > 0;
	const selectionCount = [
		hasKey,
		hasSessionId,
		(normalizeOptionalString(p.label) ?? "").length > 0
	].filter(Boolean).length;
	if (selectionCount > 1) return {
		ok: false,
		error: errorShape(ErrorCodes.INVALID_REQUEST, "Provide either key, sessionId, or label (not multiple)")
	};
	if (selectionCount === 0) return {
		ok: false,
		error: errorShape(ErrorCodes.INVALID_REQUEST, "Either key, sessionId, or label is required")
	};
	if (hasKey) {
		const target = resolveGatewaySessionStoreTarget({
			cfg,
			key
		});
		const store = loadSessionStore(target.storePath);
		if (store[target.canonicalKey]) {
			if (!isResolvedSessionKeyVisible({
				cfg,
				p,
				storePath: target.storePath,
				store,
				key: target.canonicalKey
			})) return noSessionFoundResult(key);
			const agentCheck = validateSessionAgentExists(cfg, target.canonicalKey);
			if (agentCheck) return agentCheck;
			return {
				ok: true,
				key: target.canonicalKey
			};
		}
		const legacyKey = target.storeKeys.find((candidate) => store[candidate]);
		if (!legacyKey) return noSessionFoundResult(key);
		await updateSessionStore(target.storePath, (s) => {
			const { primaryKey } = migrateAndPruneGatewaySessionStoreKey({
				cfg,
				key,
				store: s
			});
			if (!s[primaryKey] && s[legacyKey]) s[primaryKey] = s[legacyKey];
		});
		if (!isResolvedSessionKeyVisible({
			cfg,
			p,
			storePath: target.storePath,
			store: loadSessionStore(target.storePath),
			key: target.canonicalKey
		})) return noSessionFoundResult(key);
		const agentCheckLegacy = validateSessionAgentExists(cfg, target.canonicalKey);
		if (agentCheckLegacy) return agentCheckLegacy;
		return {
			ok: true,
			key: target.canonicalKey
		};
	}
	if (hasSessionId) {
		const { store } = loadCombinedSessionStoreForGateway(cfg, { agentId: p.agentId });
		const selection = resolveSessionIdMatchSelection(findVisibleSessionIdMatches({
			cfg,
			store,
			p,
			sessionId
		}), sessionId);
		if (selection.kind === "none") return {
			ok: false,
			error: errorShape(ErrorCodes.INVALID_REQUEST, `No session found: ${sessionId}`)
		};
		if (selection.kind === "ambiguous") {
			const keys = selection.sessionKeys.join(", ");
			return {
				ok: false,
				error: errorShape(ErrorCodes.INVALID_REQUEST, `Multiple sessions found for sessionId: ${sessionId} (${keys})`)
			};
		}
		const agentCheckSessionId = validateSessionAgentExists(cfg, selection.sessionKey);
		if (agentCheckSessionId) return agentCheckSessionId;
		return {
			ok: true,
			key: selection.sessionKey
		};
	}
	const parsedLabel = parseSessionLabel(p.label);
	if (!parsedLabel.ok) return {
		ok: false,
		error: errorShape(ErrorCodes.INVALID_REQUEST, parsedLabel.error)
	};
	const { storePath, store } = loadCombinedSessionStoreForGateway(cfg, { agentId: p.agentId });
	const list = listSessionsFromStore({
		cfg,
		storePath,
		store,
		opts: {
			includeGlobal: p.includeGlobal === true,
			includeUnknown: p.includeUnknown === true,
			label: parsedLabel.label,
			agentId: p.agentId,
			spawnedBy: p.spawnedBy,
			limit: 2
		}
	});
	if (list.sessions.length === 0) return {
		ok: false,
		error: errorShape(ErrorCodes.INVALID_REQUEST, `No session found with label: ${parsedLabel.label}`)
	};
	if (list.sessions.length > 1) {
		const keys = list.sessions.map((s) => s.key).join(", ");
		return {
			ok: false,
			error: errorShape(ErrorCodes.INVALID_REQUEST, `Multiple sessions found with label: ${parsedLabel.label} (${keys})`)
		};
	}
	const agentCheckLabel = validateSessionAgentExists(cfg, list.sessions[0].key);
	if (agentCheckLabel) return agentCheckLabel;
	return {
		ok: true,
		key: list.sessions[0].key
	};
}
//#endregion
export { resolveSessionKeyFromResolveParams as t };
