import { t as createAsyncLock } from "./async-lock-CaiUOILd.js";
import { t as normalizeArrayBackedTrimmedStringList } from "./string-normalization-DiPHgdft.js";
import { a as readJsonIfExists, m as writeJson } from "./json-files-C2hqjU--.js";
import { t as resolveNodePairApprovalScopes } from "./node-pairing-authz-BEOIjx2Q.js";
import { a as reconcilePendingPairingRequests, i as pruneExpiredPending, n as verifyPairingToken, o as resolvePairingPaths, r as coercePairingStateRecord, s as resolveMissingRequestedScope, t as generatePairingToken } from "./pairing-token-CX9_g8Xs.js";
import { randomUUID } from "node:crypto";
//#region src/infra/pairing-pending.ts
async function rejectPendingPairingRequest(params) {
	const state = await params.loadState();
	const pending = state.pendingById[params.requestId];
	if (!pending) return null;
	delete state.pendingById[params.requestId];
	await params.persistState(state);
	return {
		requestId: params.requestId,
		[params.idKey]: params.getId(pending)
	};
}
//#endregion
//#region src/infra/node-pairing.ts
const PENDING_TTL_MS = 300 * 1e3;
const OPERATOR_ROLE = "operator";
const withLock = createAsyncLock();
function buildPendingNodePairingRequest(params) {
	return {
		requestId: params.requestId ?? randomUUID(),
		nodeId: params.req.nodeId,
		clientId: params.req.clientId,
		clientMode: params.req.clientMode,
		displayName: params.req.displayName,
		platform: params.req.platform,
		version: params.req.version,
		coreVersion: params.req.coreVersion,
		uiVersion: params.req.uiVersion,
		deviceFamily: params.req.deviceFamily,
		modelIdentifier: params.req.modelIdentifier,
		caps: normalizeArrayBackedTrimmedStringList(params.req.caps),
		commands: normalizeArrayBackedTrimmedStringList(params.req.commands),
		permissions: params.req.permissions,
		remoteIp: params.req.remoteIp,
		silent: params.req.silent,
		ts: Date.now()
	};
}
function refreshPendingNodePairingRequest(existing, incoming) {
	return {
		...existing,
		clientId: incoming.clientId ?? existing.clientId,
		clientMode: incoming.clientMode ?? existing.clientMode,
		displayName: incoming.displayName ?? existing.displayName,
		platform: incoming.platform ?? existing.platform,
		version: incoming.version ?? existing.version,
		coreVersion: incoming.coreVersion ?? existing.coreVersion,
		uiVersion: incoming.uiVersion ?? existing.uiVersion,
		deviceFamily: incoming.deviceFamily ?? existing.deviceFamily,
		modelIdentifier: incoming.modelIdentifier ?? existing.modelIdentifier,
		caps: normalizeArrayBackedTrimmedStringList(incoming.caps) ?? existing.caps,
		commands: normalizeArrayBackedTrimmedStringList(incoming.commands) ?? existing.commands,
		permissions: incoming.permissions ?? existing.permissions,
		remoteIp: incoming.remoteIp ?? existing.remoteIp,
		silent: Boolean(existing.silent && incoming.silent),
		ts: Date.now()
	};
}
function normalizeApprovalSurfaceList(value) {
	return normalizeArrayBackedTrimmedStringList(value) ?? [];
}
function sameApprovalSurfaceSet(left, right) {
	const normalizedLeft = new Set(normalizeApprovalSurfaceList(left));
	const normalizedRight = new Set(normalizeApprovalSurfaceList(right));
	if (normalizedLeft.size !== normalizedRight.size) return false;
	for (const entry of normalizedLeft) if (!normalizedRight.has(entry)) return false;
	return true;
}
function samePermissions(left, right) {
	const leftEntries = Object.entries(left ?? {}).toSorted(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
	const rightEntries = Object.entries(right ?? {}).toSorted(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
	if (leftEntries.length !== rightEntries.length) return false;
	return leftEntries.every(([key, value], index) => {
		const rightEntry = rightEntries[index];
		return rightEntry !== void 0 && rightEntry[0] === key && rightEntry[1] === value;
	});
}
function samePendingApprovalSurface(existing, incoming) {
	const incomingCaps = normalizeArrayBackedTrimmedStringList(incoming.caps) ?? existing.caps;
	const incomingCommands = normalizeArrayBackedTrimmedStringList(incoming.commands) ?? existing.commands;
	const incomingPermissions = incoming.permissions ?? existing.permissions;
	return sameApprovalSurfaceSet(existing.caps, incomingCaps) && sameApprovalSurfaceSet(existing.commands, incomingCommands) && samePermissions(existing.permissions, incomingPermissions);
}
function mergeNodePairingReplacementInput(params) {
	const latest = params.existing[0];
	return {
		nodeId: params.incoming.nodeId,
		clientId: params.incoming.clientId ?? latest?.clientId,
		clientMode: params.incoming.clientMode ?? latest?.clientMode,
		displayName: params.incoming.displayName ?? latest?.displayName,
		platform: params.incoming.platform ?? latest?.platform,
		version: params.incoming.version ?? latest?.version,
		coreVersion: params.incoming.coreVersion ?? latest?.coreVersion,
		uiVersion: params.incoming.uiVersion ?? latest?.uiVersion,
		deviceFamily: params.incoming.deviceFamily ?? latest?.deviceFamily,
		modelIdentifier: params.incoming.modelIdentifier ?? latest?.modelIdentifier,
		caps: params.incoming.caps ?? latest?.caps,
		commands: params.incoming.commands ?? latest?.commands,
		permissions: params.incoming.permissions ?? latest?.permissions,
		remoteIp: params.incoming.remoteIp ?? latest?.remoteIp,
		silent: Boolean(params.incoming.silent && params.existing.every((pending) => pending.silent === true))
	};
}
function resolveNodeApprovalRequiredScopes(pending) {
	return resolveNodePairApprovalScopes(Array.isArray(pending.commands) ? pending.commands : []);
}
function toPendingNodePairingEntry(pending) {
	return {
		...pending,
		requiredApproveScopes: resolveNodeApprovalRequiredScopes(pending)
	};
}
async function loadState(baseDir) {
	const { pendingPath, pairedPath } = resolvePairingPaths(baseDir, "nodes");
	const [pending, paired] = await Promise.all([readJsonIfExists(pendingPath), readJsonIfExists(pairedPath)]);
	const state = {
		pendingById: coercePairingStateRecord(pending),
		pairedByNodeId: coercePairingStateRecord(paired)
	};
	pruneExpiredPending(state.pendingById, Date.now(), PENDING_TTL_MS);
	return state;
}
async function persistState(state, baseDir) {
	const { pendingPath, pairedPath } = resolvePairingPaths(baseDir, "nodes");
	await Promise.all([writeJson(pendingPath, state.pendingById), writeJson(pairedPath, state.pairedByNodeId)]);
}
function normalizeNodeId(nodeId) {
	return nodeId.trim();
}
function newToken() {
	return generatePairingToken();
}
async function listNodePairing(baseDir) {
	const state = await loadState(baseDir);
	return {
		pending: Object.values(state.pendingById).toSorted((a, b) => b.ts - a.ts).map(toPendingNodePairingEntry),
		paired: Object.values(state.pairedByNodeId).toSorted((a, b) => b.approvedAtMs - a.approvedAtMs)
	};
}
async function getPairedNode(nodeId, baseDir) {
	return (await loadState(baseDir)).pairedByNodeId[normalizeNodeId(nodeId)] ?? null;
}
async function requestNodePairing(req, baseDir) {
	return await withLock(async () => {
		const state = await loadState(baseDir);
		const nodeId = normalizeNodeId(req.nodeId);
		if (!nodeId) throw new Error("nodeId required");
		const pendingForNode = Object.values(state.pendingById).filter((pending) => pending.nodeId === nodeId).toSorted((left, right) => right.ts - left.ts);
		const result = await reconcilePendingPairingRequests({
			pendingById: state.pendingById,
			existing: pendingForNode,
			incoming: {
				...req,
				nodeId
			},
			canRefreshSingle: (existing, incoming) => samePendingApprovalSurface(existing, incoming),
			refreshSingle: (existing, incoming) => refreshPendingNodePairingRequest(existing, incoming),
			buildReplacement: ({ existing, incoming }) => buildPendingNodePairingRequest({ req: mergeNodePairingReplacementInput({
				existing,
				incoming
			}) }),
			persist: async () => await persistState(state, baseDir)
		});
		const superseded = result.created ? pendingForNode.filter((pending) => pending.requestId !== result.request.requestId).map((pending) => ({
			requestId: pending.requestId,
			nodeId: pending.nodeId
		})) : [];
		return superseded.length > 0 ? {
			...result,
			superseded
		} : result;
	});
}
async function approveNodePairing(requestId, options, baseDir) {
	return await withLock(async () => {
		const state = await loadState(baseDir);
		const pending = state.pendingById[requestId];
		if (!pending) return null;
		const missingScope = resolveMissingRequestedScope({
			role: OPERATOR_ROLE,
			requestedScopes: resolveNodeApprovalRequiredScopes(pending),
			allowedScopes: options.callerScopes ?? []
		});
		if (missingScope) return {
			status: "forbidden",
			missingScope
		};
		const now = Date.now();
		const existing = state.pairedByNodeId[pending.nodeId];
		const node = {
			nodeId: pending.nodeId,
			token: newToken(),
			clientId: pending.clientId,
			clientMode: pending.clientMode,
			displayName: pending.displayName,
			platform: pending.platform,
			version: pending.version,
			coreVersion: pending.coreVersion,
			uiVersion: pending.uiVersion,
			deviceFamily: pending.deviceFamily,
			modelIdentifier: pending.modelIdentifier,
			caps: pending.caps,
			commands: pending.commands,
			permissions: pending.permissions,
			remoteIp: pending.remoteIp,
			createdAtMs: existing?.createdAtMs ?? now,
			approvedAtMs: now
		};
		delete state.pendingById[requestId];
		state.pairedByNodeId[pending.nodeId] = node;
		await persistState(state, baseDir);
		return {
			requestId,
			node
		};
	});
}
async function rejectNodePairing(requestId, baseDir) {
	return await withLock(async () => {
		return await rejectPendingPairingRequest({
			requestId,
			idKey: "nodeId",
			loadState: () => loadState(baseDir),
			persistState: (state) => persistState(state, baseDir),
			getId: (pending) => pending.nodeId
		});
	});
}
async function removePairedNode(nodeId, baseDir) {
	return await withLock(async () => {
		const state = await loadState(baseDir);
		const normalized = normalizeNodeId(nodeId);
		if (!normalized || !state.pairedByNodeId[normalized]) return null;
		delete state.pairedByNodeId[normalized];
		await persistState(state, baseDir);
		return { nodeId: normalized };
	});
}
async function verifyNodeToken(nodeId, token, baseDir) {
	const state = await loadState(baseDir);
	const normalized = normalizeNodeId(nodeId);
	const node = state.pairedByNodeId[normalized];
	if (!node) return { ok: false };
	return verifyPairingToken(token, node.token) ? {
		ok: true,
		node
	} : { ok: false };
}
async function updatePairedNodeMetadata(nodeId, patch, baseDir) {
	return await withLock(async () => {
		const state = await loadState(baseDir);
		const normalized = normalizeNodeId(nodeId);
		const existing = state.pairedByNodeId[normalized];
		if (!existing) return false;
		const next = {
			...existing,
			clientId: patch.clientId ?? existing.clientId,
			clientMode: patch.clientMode ?? existing.clientMode,
			displayName: patch.displayName ?? existing.displayName,
			platform: patch.platform ?? existing.platform,
			version: patch.version ?? existing.version,
			coreVersion: patch.coreVersion ?? existing.coreVersion,
			uiVersion: patch.uiVersion ?? existing.uiVersion,
			deviceFamily: patch.deviceFamily ?? existing.deviceFamily,
			modelIdentifier: patch.modelIdentifier ?? existing.modelIdentifier,
			remoteIp: patch.remoteIp ?? existing.remoteIp,
			caps: patch.caps ?? existing.caps,
			commands: patch.commands ?? existing.commands,
			bins: patch.bins ?? existing.bins,
			permissions: patch.permissions ?? existing.permissions,
			lastConnectedAtMs: patch.lastConnectedAtMs ?? existing.lastConnectedAtMs,
			lastSeenAtMs: patch.lastSeenAtMs ?? existing.lastSeenAtMs,
			lastSeenReason: patch.lastSeenReason ?? existing.lastSeenReason
		};
		state.pairedByNodeId[normalized] = next;
		await persistState(state, baseDir);
		return true;
	});
}
async function renamePairedNode(nodeId, displayName, baseDir) {
	return await withLock(async () => {
		const state = await loadState(baseDir);
		const normalized = normalizeNodeId(nodeId);
		const existing = state.pairedByNodeId[normalized];
		if (!existing) return null;
		const trimmed = displayName.trim();
		if (!trimmed) throw new Error("displayName required");
		const next = {
			...existing,
			displayName: trimmed
		};
		state.pairedByNodeId[normalized] = next;
		await persistState(state, baseDir);
		return next;
	});
}
//#endregion
export { removePairedNode as a, updatePairedNodeMetadata as c, rejectNodePairing as i, verifyNodeToken as l, getPairedNode as n, renamePairedNode as o, listNodePairing as r, requestNodePairing as s, approveNodePairing as t };
