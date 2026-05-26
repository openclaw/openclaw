import { t as createAsyncLock } from "./async-lock-CaiUOILd.js";
import { m as writeJson, o as tryReadJson } from "./json-files-C2hqjU--.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { i as normalizeDevicePublicKeyBase64Url } from "./device-identity-BuQ9YOu8.js";
import { n as normalizeDeviceAuthScopes, t as normalizeDeviceAuthRole } from "./device-auth-CLuEWAWX.js";
import { i as pruneExpiredPending, l as roleScopesAllow, n as verifyPairingToken, o as resolvePairingPaths, t as generatePairingToken } from "./pairing-token-CX9_g8Xs.js";
import path from "node:path";
//#region src/shared/device-bootstrap-profile.ts
const BOOTSTRAP_HANDOFF_OPERATOR_SCOPES = [
	"operator.approvals",
	"operator.read",
	"operator.write"
];
const BOOTSTRAP_HANDOFF_OPERATOR_SCOPE_SET = new Set(BOOTSTRAP_HANDOFF_OPERATOR_SCOPES);
const PAIRING_SETUP_BOOTSTRAP_PROFILE = {
	roles: ["node", "operator"],
	scopes: [...BOOTSTRAP_HANDOFF_OPERATOR_SCOPES]
};
function resolveBootstrapProfileScopesForRole(role, scopes) {
	const normalizedRole = normalizeDeviceAuthRole(role);
	const normalizedScopes = normalizeDeviceAuthScopes(Array.from(scopes));
	if (normalizedRole === "operator") return normalizedScopes.filter((scope) => BOOTSTRAP_HANDOFF_OPERATOR_SCOPE_SET.has(scope));
	return [];
}
function resolveBootstrapProfileScopesForRoles(roles, scopes) {
	return normalizeDeviceAuthScopes(roles.flatMap((role) => resolveBootstrapProfileScopesForRole(role, scopes)));
}
function normalizeDeviceBootstrapHandoffProfile(input) {
	const profile = normalizeDeviceBootstrapProfile(input);
	return {
		roles: profile.roles,
		scopes: resolveBootstrapProfileScopesForRoles(profile.roles, profile.scopes)
	};
}
function normalizeBootstrapRoles(roles) {
	if (!Array.isArray(roles)) return [];
	const out = /* @__PURE__ */ new Set();
	for (const role of roles) {
		const normalized = normalizeDeviceAuthRole(role);
		if (normalized) out.add(normalized);
	}
	return [...out].toSorted();
}
function normalizeDeviceBootstrapProfile(input) {
	return {
		roles: normalizeBootstrapRoles(input?.roles),
		scopes: normalizeDeviceAuthScopes(input?.scopes ? [...input.scopes] : [])
	};
}
//#endregion
//#region src/infra/device-bootstrap.ts
const DEVICE_BOOTSTRAP_TOKEN_TTL_MS = 600 * 1e3;
const withLock = createAsyncLock();
const log = createSubsystemLogger("device-bootstrap");
function resolveBootstrapPath(baseDir) {
	return path.join(resolvePairingPaths(baseDir, "devices").dir, "bootstrap.json");
}
function resolveIssuedBootstrapProfileInput(params) {
	if (params.profile) return params.profile;
	if (params.roles || params.scopes) return {
		roles: params.roles,
		scopes: params.scopes
	};
}
function resolvePersistedBootstrapProfile(record) {
	return normalizeDeviceBootstrapProfile(record.profile ?? record);
}
function resolvePersistedRedeemedProfile(record) {
	return normalizeDeviceBootstrapProfile(record.redeemedProfile);
}
function resolvePersistedPendingProfile(record) {
	return record.pendingProfile ? normalizeDeviceBootstrapProfile(record.pendingProfile) : null;
}
function resolveRequestedBootstrapProfile(params) {
	return normalizeDeviceBootstrapProfile({
		roles: [params.role],
		scopes: resolveBootstrapProfileScopesForRole(params.role, params.scopes)
	});
}
function sameBootstrapProfile(left, right) {
	if (left.roles.length !== right.roles.length || left.scopes.length !== right.scopes.length) return false;
	return left.roles.every((role, index) => role === right.roles[index]) && left.scopes.every((scope, index) => scope === right.scopes[index]);
}
function resolveIssuedBootstrapProfile(params) {
	const input = resolveIssuedBootstrapProfileInput(params);
	if (input) return normalizeDeviceBootstrapHandoffProfile(input);
	return PAIRING_SETUP_BOOTSTRAP_PROFILE;
}
function warnIfIssuedBootstrapScopesWereStripped(params) {
	if (!params.input) return;
	const requestedProfile = normalizeDeviceBootstrapProfile(params.input);
	const requestedScopes = requestedProfile.scopes;
	if (requestedScopes.length === 0) return;
	const retainedScopeSet = new Set(params.profile.scopes);
	const strippedScopes = requestedScopes.filter((scope) => !retainedScopeSet.has(scope));
	if (strippedScopes.length === 0) return;
	log.warn("bootstrap_token_scopes_stripped", {
		roles: requestedProfile.roles,
		requestedScopes,
		retainedScopes: params.profile.scopes,
		strippedScopes,
		consoleMessage: "bootstrap token scopes stripped to bootstrap handoff allowlist"
	});
}
function bootstrapProfileAllowsRequest(params) {
	return params.allowedProfile.roles.includes(params.requestedRole) && roleScopesAllow({
		role: params.requestedRole,
		requestedScopes: params.requestedScopes,
		allowedScopes: params.allowedProfile.scopes
	});
}
function bootstrapProfileSatisfiesProfile(params) {
	for (const requiredRole of params.requiredProfile.roles) {
		if (!params.actualProfile.roles.includes(requiredRole)) return false;
		const requiredScopes = resolveBootstrapProfileScopesForRole(requiredRole, params.requiredProfile.scopes);
		if (requiredScopes.length > 0 && !bootstrapProfileAllowsRequest({
			allowedProfile: params.actualProfile,
			requestedRole: requiredRole,
			requestedScopes: requiredScopes
		})) return false;
	}
	return true;
}
function normalizeBootstrapPublicKey(publicKey) {
	const trimmed = publicKey.trim();
	if (!trimmed) return "";
	if (trimmed.includes("BEGIN") || /[+/=]/.test(trimmed)) return normalizeDevicePublicKeyBase64Url(trimmed) ?? trimmed;
	return trimmed;
}
async function loadState(baseDir) {
	const rawState = await tryReadJson(resolveBootstrapPath(baseDir)) ?? {};
	const state = {};
	if (!rawState || typeof rawState !== "object" || Array.isArray(rawState)) return state;
	for (const [tokenKey, entry] of Object.entries(rawState)) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
		const record = entry;
		const token = typeof record.token === "string" && record.token.trim().length > 0 ? record.token : tokenKey;
		const issuedAtMs = typeof record.issuedAtMs === "number" ? record.issuedAtMs : 0;
		const profile = resolvePersistedBootstrapProfile(record);
		const pendingProfile = resolvePersistedPendingProfile(record);
		state[tokenKey] = {
			token,
			profile,
			redeemedProfile: resolvePersistedRedeemedProfile(record),
			...pendingProfile ? { pendingProfile } : {},
			deviceId: typeof record.deviceId === "string" ? record.deviceId : void 0,
			publicKey: typeof record.publicKey === "string" ? record.publicKey : void 0,
			issuedAtMs,
			ts: typeof record.ts === "number" ? record.ts : issuedAtMs,
			lastUsedAtMs: typeof record.lastUsedAtMs === "number" ? record.lastUsedAtMs : void 0
		};
	}
	pruneExpiredPending(state, Date.now(), DEVICE_BOOTSTRAP_TOKEN_TTL_MS);
	return state;
}
async function persistState(state, baseDir) {
	await writeJson(resolveBootstrapPath(baseDir), state);
}
async function issueDeviceBootstrapToken(params = {}) {
	return await withLock(async () => {
		const state = await loadState(params.baseDir);
		const token = generatePairingToken();
		const issuedAtMs = Date.now();
		const profileInput = resolveIssuedBootstrapProfileInput(params);
		const profile = resolveIssuedBootstrapProfile(params);
		warnIfIssuedBootstrapScopesWereStripped({
			input: profileInput,
			profile
		});
		state[token] = {
			token,
			ts: issuedAtMs,
			profile,
			redeemedProfile: normalizeDeviceBootstrapProfile(void 0),
			issuedAtMs
		};
		await persistState(state, params.baseDir);
		return {
			token,
			expiresAtMs: issuedAtMs + DEVICE_BOOTSTRAP_TOKEN_TTL_MS
		};
	});
}
async function clearDeviceBootstrapTokens(params = {}) {
	return await withLock(async () => {
		const state = await loadState(params.baseDir);
		const removed = Object.keys(state).length;
		await persistState({}, params.baseDir);
		return { removed };
	});
}
async function revokeDeviceBootstrapToken(params) {
	return await withLock(async () => {
		const providedToken = params.token.trim();
		if (!providedToken) return { removed: false };
		const state = await loadState(params.baseDir);
		const found = Object.entries(state).find(([, candidate]) => verifyPairingToken(providedToken, candidate.token));
		if (!found) return { removed: false };
		const [tokenKey, record] = found;
		delete state[tokenKey];
		await persistState(state, params.baseDir);
		return {
			removed: true,
			record
		};
	});
}
async function revokeDeviceBootstrapTokensForDevice(params) {
	return await withLock(async () => {
		const deviceId = params.deviceId.trim();
		const publicKey = normalizeBootstrapPublicKey(params.publicKey);
		if (!deviceId || !publicKey) return { removed: 0 };
		const state = await loadState(params.baseDir);
		let removed = 0;
		for (const [tokenKey, record] of Object.entries(state)) {
			const recordPublicKey = typeof record.publicKey === "string" ? normalizeBootstrapPublicKey(record.publicKey) : void 0;
			if (record.deviceId?.trim() === deviceId && recordPublicKey === publicKey) {
				delete state[tokenKey];
				removed += 1;
			}
		}
		if (removed > 0) await persistState(state, params.baseDir);
		return { removed };
	});
}
async function restoreDeviceBootstrapToken(params) {
	return await withLock(async () => {
		const state = await loadState(params.baseDir);
		state[params.record.token] = params.record;
		await persistState(state, params.baseDir);
	});
}
async function getDeviceBootstrapTokenProfile(params) {
	return await withLock(async () => {
		const providedToken = params.token.trim();
		if (!providedToken) return null;
		const state = await loadState(params.baseDir);
		const found = Object.values(state).find((candidate) => verifyPairingToken(providedToken, candidate.token));
		return found ? resolvePersistedBootstrapProfile(found) : null;
	});
}
async function redeemDeviceBootstrapTokenProfile(params) {
	return await withLock(async () => {
		const providedToken = params.token.trim();
		if (!providedToken) return {
			recorded: false,
			fullyRedeemed: false
		};
		const state = await loadState(params.baseDir);
		const found = Object.entries(state).find(([, candidate]) => verifyPairingToken(providedToken, candidate.token));
		if (!found) return {
			recorded: false,
			fullyRedeemed: false
		};
		const [tokenKey, record] = found;
		const issuedProfile = resolvePersistedBootstrapProfile(record);
		const pendingProfile = resolvePersistedPendingProfile(record);
		const redeemedProfile = normalizeDeviceBootstrapProfile({
			roles: [...resolvePersistedRedeemedProfile(record).roles, params.role],
			scopes: [...resolvePersistedRedeemedProfile(record).scopes, ...resolveBootstrapProfileScopesForRole(params.role, params.scopes)]
		});
		const nextPendingProfile = pendingProfile && !bootstrapProfileSatisfiesProfile({
			actualProfile: redeemedProfile,
			requiredProfile: pendingProfile
		}) ? pendingProfile : void 0;
		const nextRecord = {
			...record,
			profile: issuedProfile,
			redeemedProfile
		};
		if (nextPendingProfile) nextRecord.pendingProfile = nextPendingProfile;
		else delete nextRecord.pendingProfile;
		state[tokenKey] = nextRecord;
		await persistState(state, params.baseDir);
		return {
			recorded: true,
			fullyRedeemed: bootstrapProfileSatisfiesProfile({
				actualProfile: redeemedProfile,
				requiredProfile: issuedProfile
			})
		};
	});
}
async function verifyDeviceBootstrapToken(params) {
	return await withLock(async () => {
		const state = await loadState(params.baseDir);
		const providedToken = params.token.trim();
		if (!providedToken) return {
			ok: false,
			reason: "bootstrap_token_invalid"
		};
		const found = Object.entries(state).find(([, candidate]) => verifyPairingToken(providedToken, candidate.token));
		if (!found) return {
			ok: false,
			reason: "bootstrap_token_invalid"
		};
		const [tokenKey, record] = found;
		const deviceId = params.deviceId.trim();
		const publicKey = normalizeBootstrapPublicKey(params.publicKey);
		const role = params.role.trim();
		if (!deviceId || !publicKey || !role) return {
			ok: false,
			reason: "bootstrap_token_invalid"
		};
		const allowedProfile = resolvePersistedBootstrapProfile(record);
		if (allowedProfile.roles.length === 0 || !bootstrapProfileAllowsRequest({
			allowedProfile,
			requestedRole: role,
			requestedScopes: params.scopes
		})) return {
			ok: false,
			reason: "bootstrap_token_invalid"
		};
		const requestedProfile = resolveRequestedBootstrapProfile({
			role,
			scopes: params.scopes
		});
		const boundDeviceId = record.deviceId?.trim();
		const boundPublicKey = typeof record.publicKey === "string" ? normalizeBootstrapPublicKey(record.publicKey) : void 0;
		if (boundDeviceId || boundPublicKey) {
			if (boundDeviceId !== deviceId || boundPublicKey !== publicKey) return {
				ok: false,
				reason: "bootstrap_token_invalid"
			};
			const pendingProfile = resolvePersistedPendingProfile(record);
			if (pendingProfile && !sameBootstrapProfile(pendingProfile, requestedProfile)) return {
				ok: false,
				reason: "bootstrap_token_invalid"
			};
			state[tokenKey] = {
				...record,
				profile: allowedProfile,
				pendingProfile: pendingProfile ?? requestedProfile,
				deviceId,
				publicKey,
				lastUsedAtMs: Date.now()
			};
			await persistState(state, params.baseDir);
			return { ok: true };
		}
		state[tokenKey] = {
			...record,
			profile: allowedProfile,
			pendingProfile: requestedProfile,
			deviceId,
			publicKey,
			lastUsedAtMs: Date.now()
		};
		await persistState(state, params.baseDir);
		return { ok: true };
	});
}
/**
* Reads the already-bound bootstrap profile for a verified device identity.
*
* Call this only after `verifyDeviceBootstrapToken()` has returned `{ ok: true }`
* for the same `token` / `deviceId` / `publicKey` tuple in the current handshake.
*/
async function getBoundDeviceBootstrapProfile(params) {
	return await withLock(async () => {
		const state = await loadState(params.baseDir);
		const providedToken = params.token.trim();
		if (!providedToken) return null;
		const found = Object.entries(state).find(([, candidate]) => verifyPairingToken(providedToken, candidate.token));
		if (!found) return null;
		const [, record] = found;
		const deviceId = params.deviceId.trim();
		const publicKey = normalizeBootstrapPublicKey(params.publicKey);
		if (!deviceId || !publicKey) return null;
		const recordPublicKey = typeof record.publicKey === "string" ? normalizeBootstrapPublicKey(record.publicKey) : void 0;
		if (record.deviceId?.trim() !== deviceId || recordPublicKey !== publicKey) return null;
		return resolvePersistedBootstrapProfile(record);
	});
}
//#endregion
export { redeemDeviceBootstrapTokenProfile as a, revokeDeviceBootstrapTokensForDevice as c, PAIRING_SETUP_BOOTSTRAP_PROFILE as d, normalizeDeviceBootstrapProfile as f, issueDeviceBootstrapToken as i, verifyDeviceBootstrapToken as l, resolveBootstrapProfileScopesForRoles as m, getBoundDeviceBootstrapProfile as n, restoreDeviceBootstrapToken as o, resolveBootstrapProfileScopesForRole as p, getDeviceBootstrapTokenProfile as r, revokeDeviceBootstrapToken as s, clearDeviceBootstrapTokens as t, BOOTSTRAP_HANDOFF_OPERATOR_SCOPES as u };
