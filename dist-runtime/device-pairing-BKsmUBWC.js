import { Br as generatePairingToken, Hr as rejectPendingPairingRequest, Ur as pruneExpiredPending, Vr as verifyPairingToken, Wr as resolvePairingPaths } from "./auth-profiles-DqxBs6Au.js";
import { n as readJsonFile, r as writeJsonAtomic, t as createAsyncLock } from "./json-files-DTtlIKNR.js";
import { en as normalizeDeviceAuthScopes } from "./method-scopes-DDb5C1xl.js";
import { randomUUID } from "node:crypto";
//#region src/shared/operator-scope-compat.ts
const OPERATOR_ROLE = "operator";
const OPERATOR_ADMIN_SCOPE = "operator.admin";
const OPERATOR_READ_SCOPE = "operator.read";
const OPERATOR_WRITE_SCOPE = "operator.write";
const OPERATOR_SCOPE_PREFIX = "operator.";
function normalizeScopeList(scopes) {
	const out = /* @__PURE__ */ new Set();
	for (const scope of scopes) {
		const trimmed = scope.trim();
		if (trimmed) {out.add(trimmed);}
	}
	return [...out];
}
function operatorScopeSatisfied(requestedScope, granted) {
	if (granted.has(OPERATOR_ADMIN_SCOPE) && requestedScope.startsWith(OPERATOR_SCOPE_PREFIX)) {return true;}
	if (requestedScope === OPERATOR_READ_SCOPE) {return granted.has(OPERATOR_READ_SCOPE) || granted.has(OPERATOR_WRITE_SCOPE);}
	if (requestedScope === OPERATOR_WRITE_SCOPE) {return granted.has(OPERATOR_WRITE_SCOPE);}
	return granted.has(requestedScope);
}
function roleScopesAllow(params) {
	const requested = normalizeScopeList(params.requestedScopes);
	if (requested.length === 0) {return true;}
	const allowed = normalizeScopeList(params.allowedScopes);
	if (allowed.length === 0) {return false;}
	const allowedSet = new Set(allowed);
	if (params.role.trim() !== OPERATOR_ROLE) {return requested.every((scope) => allowedSet.has(scope));}
	return requested.every((scope) => operatorScopeSatisfied(scope, allowedSet));
}
//#endregion
//#region src/infra/device-pairing.ts
const PENDING_TTL_MS = 300 * 1e3;
const withLock = createAsyncLock();
async function loadState(baseDir) {
	const { pendingPath, pairedPath } = resolvePairingPaths(baseDir, "devices");
	const [pending, paired] = await Promise.all([readJsonFile(pendingPath), readJsonFile(pairedPath)]);
	const state = {
		pendingById: pending ?? {},
		pairedByDeviceId: paired ?? {}
	};
	pruneExpiredPending(state.pendingById, Date.now(), PENDING_TTL_MS);
	return state;
}
async function persistState(state, baseDir) {
	const { pendingPath, pairedPath } = resolvePairingPaths(baseDir, "devices");
	await Promise.all([writeJsonAtomic(pendingPath, state.pendingById), writeJsonAtomic(pairedPath, state.pairedByDeviceId)]);
}
function normalizeDeviceId(deviceId) {
	return deviceId.trim();
}
function normalizeRole(role) {
	const trimmed = role?.trim();
	return trimmed ? trimmed : null;
}
function mergeRoles(...items) {
	const roles = /* @__PURE__ */ new Set();
	for (const item of items) {
		if (!item) {continue;}
		if (Array.isArray(item)) {for (const role of item) {
			const trimmed = role.trim();
			if (trimmed) roles.add(trimmed);
		}}
		else {
			const trimmed = item.trim();
			if (trimmed) {roles.add(trimmed);}
		}
	}
	if (roles.size === 0) {return;}
	return [...roles];
}
function mergeScopes(...items) {
	const scopes = /* @__PURE__ */ new Set();
	for (const item of items) {
		if (!item) {continue;}
		for (const scope of item) {
			const trimmed = scope.trim();
			if (trimmed) {scopes.add(trimmed);}
		}
	}
	if (scopes.size === 0) {return;}
	return [...scopes];
}
function mergePendingDevicePairingRequest(existing, incoming, isRepair) {
	const existingRole = normalizeRole(existing.role);
	const incomingRole = normalizeRole(incoming.role);
	return {
		...existing,
		displayName: incoming.displayName ?? existing.displayName,
		platform: incoming.platform ?? existing.platform,
		deviceFamily: incoming.deviceFamily ?? existing.deviceFamily,
		clientId: incoming.clientId ?? existing.clientId,
		clientMode: incoming.clientMode ?? existing.clientMode,
		role: existingRole ?? incomingRole ?? void 0,
		roles: mergeRoles(existing.roles, existing.role, incoming.role),
		scopes: mergeScopes(existing.scopes, incoming.scopes),
		remoteIp: incoming.remoteIp ?? existing.remoteIp,
		silent: Boolean(existing.silent && incoming.silent),
		isRepair: existing.isRepair || isRepair,
		ts: Date.now()
	};
}
function newToken() {
	return generatePairingToken();
}
function getPairedDeviceFromState(state, deviceId) {
	return state.pairedByDeviceId[normalizeDeviceId(deviceId)] ?? null;
}
function cloneDeviceTokens(device) {
	return device.tokens ? { ...device.tokens } : {};
}
function buildDeviceAuthToken(params) {
	return {
		token: newToken(),
		role: params.role,
		scopes: params.scopes,
		createdAtMs: params.existing?.createdAtMs ?? params.now,
		rotatedAtMs: params.rotatedAtMs,
		revokedAtMs: void 0,
		lastUsedAtMs: params.existing?.lastUsedAtMs
	};
}
function resolveApprovedDeviceScopeBaseline(device) {
	const baseline = device.approvedScopes ?? device.scopes;
	if (!Array.isArray(baseline)) {return null;}
	return normalizeDeviceAuthScopes(baseline);
}
function scopesWithinApprovedDeviceBaseline(params) {
	if (!params.approvedScopes) {return false;}
	return roleScopesAllow({
		role: params.role,
		requestedScopes: params.scopes,
		allowedScopes: params.approvedScopes
	});
}
function resolveMissingRequestedScope(params) {
	for (const scope of params.requestedScopes) {if (!roleScopesAllow({
		role: params.role,
		requestedScopes: [scope],
		allowedScopes: params.callerScopes
	})) return scope;}
	return null;
}
async function listDevicePairing(baseDir) {
	const state = await loadState(baseDir);
	return {
		pending: Object.values(state.pendingById).toSorted((a, b) => b.ts - a.ts),
		paired: Object.values(state.pairedByDeviceId).toSorted((a, b) => b.approvedAtMs - a.approvedAtMs)
	};
}
async function getPairedDevice(deviceId, baseDir) {
	return (await loadState(baseDir)).pairedByDeviceId[normalizeDeviceId(deviceId)] ?? null;
}
async function requestDevicePairing(req, baseDir) {
	return await withLock(async () => {
		const state = await loadState(baseDir);
		const deviceId = normalizeDeviceId(req.deviceId);
		if (!deviceId) {throw new Error("deviceId required");}
		const isRepair = Boolean(state.pairedByDeviceId[deviceId]);
		const existing = Object.values(state.pendingById).find((pending) => pending.deviceId === deviceId);
		if (existing) {
			const merged = mergePendingDevicePairingRequest(existing, req, isRepair);
			state.pendingById[existing.requestId] = merged;
			await persistState(state, baseDir);
			return {
				status: "pending",
				request: merged,
				created: false
			};
		}
		const request = {
			requestId: randomUUID(),
			deviceId,
			publicKey: req.publicKey,
			displayName: req.displayName,
			platform: req.platform,
			deviceFamily: req.deviceFamily,
			clientId: req.clientId,
			clientMode: req.clientMode,
			role: req.role,
			roles: req.role ? [req.role] : void 0,
			scopes: req.scopes,
			remoteIp: req.remoteIp,
			silent: req.silent,
			isRepair,
			ts: Date.now()
		};
		state.pendingById[request.requestId] = request;
		await persistState(state, baseDir);
		return {
			status: "pending",
			request,
			created: true
		};
	});
}
async function approveDevicePairing(requestId, optionsOrBaseDir, maybeBaseDir) {
	const options = typeof optionsOrBaseDir === "string" || optionsOrBaseDir === void 0 ? void 0 : optionsOrBaseDir;
	const baseDir = typeof optionsOrBaseDir === "string" ? optionsOrBaseDir : maybeBaseDir;
	return await withLock(async () => {
		const state = await loadState(baseDir);
		const pending = state.pendingById[requestId];
		if (!pending) {return null;}
		if (pending.role && options?.callerScopes) {
			const missingScope = resolveMissingRequestedScope({
				role: pending.role,
				requestedScopes: normalizeDeviceAuthScopes(pending.scopes),
				callerScopes: options.callerScopes
			});
			if (missingScope) {return {
				status: "forbidden",
				missingScope
			};}
		}
		const now = Date.now();
		const existing = state.pairedByDeviceId[pending.deviceId];
		const roles = mergeRoles(existing?.roles, existing?.role, pending.roles, pending.role);
		const approvedScopes = mergeScopes(existing?.approvedScopes ?? existing?.scopes, pending.scopes);
		const tokens = existing?.tokens ? { ...existing.tokens } : {};
		const roleForToken = normalizeRole(pending.role);
		if (roleForToken) {
			const existingToken = tokens[roleForToken];
			const requestedScopes = normalizeDeviceAuthScopes(pending.scopes);
			const nextScopes = requestedScopes.length > 0 ? requestedScopes : normalizeDeviceAuthScopes(existingToken?.scopes ?? approvedScopes ?? existing?.approvedScopes ?? existing?.scopes);
			const now = Date.now();
			tokens[roleForToken] = {
				token: newToken(),
				role: roleForToken,
				scopes: nextScopes,
				createdAtMs: existingToken?.createdAtMs ?? now,
				rotatedAtMs: existingToken ? now : void 0,
				revokedAtMs: void 0,
				lastUsedAtMs: existingToken?.lastUsedAtMs
			};
		}
		const device = {
			deviceId: pending.deviceId,
			publicKey: pending.publicKey,
			displayName: pending.displayName,
			platform: pending.platform,
			deviceFamily: pending.deviceFamily,
			clientId: pending.clientId,
			clientMode: pending.clientMode,
			role: pending.role,
			roles,
			scopes: approvedScopes,
			approvedScopes,
			remoteIp: pending.remoteIp,
			tokens,
			createdAtMs: existing?.createdAtMs ?? now,
			approvedAtMs: now
		};
		delete state.pendingById[requestId];
		state.pairedByDeviceId[device.deviceId] = device;
		await persistState(state, baseDir);
		return {
			status: "approved",
			requestId,
			device
		};
	});
}
async function rejectDevicePairing(requestId, baseDir) {
	return await withLock(async () => {
		return await rejectPendingPairingRequest({
			requestId,
			idKey: "deviceId",
			loadState: () => loadState(baseDir),
			persistState: (state) => persistState(state, baseDir),
			getId: (pending) => pending.deviceId
		});
	});
}
async function removePairedDevice(deviceId, baseDir) {
	return await withLock(async () => {
		const state = await loadState(baseDir);
		const normalized = normalizeDeviceId(deviceId);
		if (!normalized || !state.pairedByDeviceId[normalized]) {return null;}
		delete state.pairedByDeviceId[normalized];
		await persistState(state, baseDir);
		return { deviceId: normalized };
	});
}
async function updatePairedDeviceMetadata(deviceId, patch, baseDir) {
	return await withLock(async () => {
		const state = await loadState(baseDir);
		const existing = state.pairedByDeviceId[normalizeDeviceId(deviceId)];
		if (!existing) {return;}
		const roles = mergeRoles(existing.roles, existing.role, patch.role);
		const scopes = mergeScopes(existing.scopes, patch.scopes);
		state.pairedByDeviceId[deviceId] = {
			...existing,
			...patch,
			deviceId: existing.deviceId,
			createdAtMs: existing.createdAtMs,
			approvedAtMs: existing.approvedAtMs,
			approvedScopes: existing.approvedScopes,
			role: patch.role ?? existing.role,
			roles,
			scopes
		};
		await persistState(state, baseDir);
	});
}
function summarizeDeviceTokens(tokens) {
	if (!tokens) {return;}
	const summaries = Object.values(tokens).map((token) => ({
		role: token.role,
		scopes: token.scopes,
		createdAtMs: token.createdAtMs,
		rotatedAtMs: token.rotatedAtMs,
		revokedAtMs: token.revokedAtMs,
		lastUsedAtMs: token.lastUsedAtMs
	})).toSorted((a, b) => a.role.localeCompare(b.role));
	return summaries.length > 0 ? summaries : void 0;
}
async function verifyDeviceToken(params) {
	return await withLock(async () => {
		const state = await loadState(params.baseDir);
		const device = getPairedDeviceFromState(state, params.deviceId);
		if (!device) {return {
			ok: false,
			reason: "device-not-paired"
		};}
		const role = normalizeRole(params.role);
		if (!role) {return {
			ok: false,
			reason: "role-missing"
		};}
		const entry = device.tokens?.[role];
		if (!entry) {return {
			ok: false,
			reason: "token-missing"
		};}
		if (entry.revokedAtMs) {return {
			ok: false,
			reason: "token-revoked"
		};}
		if (!verifyPairingToken(params.token, entry.token)) {return {
			ok: false,
			reason: "token-mismatch"
		};}
		const approvedScopes = resolveApprovedDeviceScopeBaseline(device);
		if (!scopesWithinApprovedDeviceBaseline({
			role,
			scopes: entry.scopes,
			approvedScopes
		})) {return {
			ok: false,
			reason: "scope-mismatch"
		};}
		if (!roleScopesAllow({
			role,
			requestedScopes: normalizeDeviceAuthScopes(params.scopes),
			allowedScopes: entry.scopes
		})) {return {
			ok: false,
			reason: "scope-mismatch"
		};}
		entry.lastUsedAtMs = Date.now();
		device.tokens ??= {};
		device.tokens[role] = entry;
		state.pairedByDeviceId[device.deviceId] = device;
		await persistState(state, params.baseDir);
		return { ok: true };
	});
}
async function ensureDeviceToken(params) {
	return await withLock(async () => {
		const state = await loadState(params.baseDir);
		const requestedScopes = normalizeDeviceAuthScopes(params.scopes);
		const context = resolveDeviceTokenUpdateContext({
			state,
			deviceId: params.deviceId,
			role: params.role
		});
		if (!context) {return null;}
		const { device, role, tokens, existing } = context;
		const approvedScopes = resolveApprovedDeviceScopeBaseline(device);
		if (!scopesWithinApprovedDeviceBaseline({
			role,
			scopes: requestedScopes,
			approvedScopes
		})) {return null;}
		if (existing && !existing.revokedAtMs) {
			if (scopesWithinApprovedDeviceBaseline({
				role,
				scopes: existing.scopes,
				approvedScopes
			}) && roleScopesAllow({
				role,
				requestedScopes,
				allowedScopes: existing.scopes
			})) {return existing;}
		}
		const now = Date.now();
		const next = buildDeviceAuthToken({
			role,
			scopes: requestedScopes,
			existing,
			now,
			rotatedAtMs: existing ? now : void 0
		});
		tokens[role] = next;
		device.tokens = tokens;
		state.pairedByDeviceId[device.deviceId] = device;
		await persistState(state, params.baseDir);
		return next;
	});
}
function resolveDeviceTokenUpdateContext(params) {
	const device = getPairedDeviceFromState(params.state, params.deviceId);
	if (!device) {return null;}
	const role = normalizeRole(params.role);
	if (!role) {return null;}
	const tokens = cloneDeviceTokens(device);
	return {
		device,
		role,
		tokens,
		existing: tokens[role]
	};
}
async function rotateDeviceToken(params) {
	return await withLock(async () => {
		const state = await loadState(params.baseDir);
		const context = resolveDeviceTokenUpdateContext({
			state,
			deviceId: params.deviceId,
			role: params.role
		});
		if (!context) {return {
			ok: false,
			reason: "unknown-device-or-role"
		};}
		const { device, role, tokens, existing } = context;
		const requestedScopes = normalizeDeviceAuthScopes(params.scopes ?? existing?.scopes ?? device.scopes);
		const approvedScopes = resolveApprovedDeviceScopeBaseline(device);
		if (!approvedScopes) {return {
			ok: false,
			reason: "missing-approved-scope-baseline"
		};}
		if (!scopesWithinApprovedDeviceBaseline({
			role,
			scopes: requestedScopes,
			approvedScopes
		})) {return {
			ok: false,
			reason: "scope-outside-approved-baseline"
		};}
		const now = Date.now();
		const next = buildDeviceAuthToken({
			role,
			scopes: requestedScopes,
			existing,
			now,
			rotatedAtMs: now
		});
		tokens[role] = next;
		device.tokens = tokens;
		state.pairedByDeviceId[device.deviceId] = device;
		await persistState(state, params.baseDir);
		return {
			ok: true,
			entry: next
		};
	});
}
async function revokeDeviceToken(params) {
	return await withLock(async () => {
		const state = await loadState(params.baseDir);
		const device = state.pairedByDeviceId[normalizeDeviceId(params.deviceId)];
		if (!device) {return null;}
		const role = normalizeRole(params.role);
		if (!role) {return null;}
		if (!device.tokens?.[role]) {return null;}
		const tokens = { ...device.tokens };
		const entry = {
			...tokens[role],
			revokedAtMs: Date.now()
		};
		tokens[role] = entry;
		device.tokens = tokens;
		state.pairedByDeviceId[device.deviceId] = device;
		await persistState(state, params.baseDir);
		return entry;
	});
}
//#endregion
export { rejectDevicePairing as a, revokeDeviceToken as c, updatePairedDeviceMetadata as d, verifyDeviceToken as f, listDevicePairing as i, rotateDeviceToken as l, ensureDeviceToken as n, removePairedDevice as o, roleScopesAllow as p, getPairedDevice as r, requestDevicePairing as s, approveDevicePairing as t, summarizeDeviceTokens as u };
