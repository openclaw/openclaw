import { i as writeJsonAtomic, r as readJsonFile, t as createAsyncLock } from "./json-files-BSTIUY71.js";
import { a as normalizeDeviceAuthScopes, n as pruneExpiredPending, r as resolvePairingPaths, t as generatePairingToken } from "./pairing-token-Do-E3rL5.js";
import "node:crypto";
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
		if (trimmed) out.add(trimmed);
	}
	return [...out];
}
function operatorScopeSatisfied(requestedScope, granted) {
	if (granted.has(OPERATOR_ADMIN_SCOPE) && requestedScope.startsWith(OPERATOR_SCOPE_PREFIX)) return true;
	if (requestedScope === OPERATOR_READ_SCOPE) return granted.has(OPERATOR_READ_SCOPE) || granted.has(OPERATOR_WRITE_SCOPE);
	if (requestedScope === OPERATOR_WRITE_SCOPE) return granted.has(OPERATOR_WRITE_SCOPE);
	return granted.has(requestedScope);
}
function roleScopesAllow(params) {
	const requested = normalizeScopeList(params.requestedScopes);
	if (requested.length === 0) return true;
	const allowed = normalizeScopeList(params.allowedScopes);
	if (allowed.length === 0) return false;
	const allowedSet = new Set(allowed);
	if (params.role.trim() !== OPERATOR_ROLE) return requested.every((scope) => allowedSet.has(scope));
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
function normalizeRole(role) {
	const trimmed = role?.trim();
	return trimmed ? trimmed : null;
}
function mergeRoles(...items) {
	const roles = /* @__PURE__ */ new Set();
	for (const item of items) {
		if (!item) continue;
		if (Array.isArray(item)) for (const role of item) {
			const trimmed = role.trim();
			if (trimmed) roles.add(trimmed);
		}
		else {
			const trimmed = item.trim();
			if (trimmed) roles.add(trimmed);
		}
	}
	if (roles.size === 0) return;
	return [...roles];
}
function mergeScopes(...items) {
	const scopes = /* @__PURE__ */ new Set();
	for (const item of items) {
		if (!item) continue;
		for (const scope of item) {
			const trimmed = scope.trim();
			if (trimmed) scopes.add(trimmed);
		}
	}
	if (scopes.size === 0) return;
	return [...scopes];
}
function newToken() {
	return generatePairingToken();
}
function resolveMissingRequestedScope(params) {
	for (const scope of params.requestedScopes) if (!roleScopesAllow({
		role: params.role,
		requestedScopes: [scope],
		allowedScopes: params.callerScopes
	})) return scope;
	return null;
}
async function listDevicePairing(baseDir) {
	const state = await loadState(baseDir);
	return {
		pending: Object.values(state.pendingById).toSorted((a, b) => b.ts - a.ts),
		paired: Object.values(state.pairedByDeviceId).toSorted((a, b) => b.approvedAtMs - a.approvedAtMs)
	};
}
async function approveDevicePairing(requestId, optionsOrBaseDir, maybeBaseDir) {
	const options = typeof optionsOrBaseDir === "string" || optionsOrBaseDir === void 0 ? void 0 : optionsOrBaseDir;
	const baseDir = typeof optionsOrBaseDir === "string" ? optionsOrBaseDir : maybeBaseDir;
	return await withLock(async () => {
		const state = await loadState(baseDir);
		const pending = state.pendingById[requestId];
		if (!pending) return null;
		if (pending.role && options?.callerScopes) {
			const missingScope = resolveMissingRequestedScope({
				role: pending.role,
				requestedScopes: normalizeDeviceAuthScopes(pending.scopes),
				callerScopes: options.callerScopes
			});
			if (missingScope) return {
				status: "forbidden",
				missingScope
			};
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
//#endregion
export { listDevicePairing as n, approveDevicePairing as t };
