import { $t as resolveStateDir } from "./entry.js";
import { a as logError, i as logDebug } from "./exec-BhaMholX.js";
import { h as GATEWAY_CLIENT_NAMES, m as GATEWAY_CLIENT_MODES, p as GATEWAY_CLIENT_IDS } from "./message-channel-CJUwnCYd.js";
import { t as INPUT_PROVENANCE_KIND_VALUES } from "./input-provenance-BDYpbBeC.js";
import { a as resolvePairingPaths, c as readJsonFile, i as pruneExpiredPending, l as writeJsonAtomic, n as verifyPairingToken, r as rejectPendingPairingRequest, s as createAsyncLock, t as generatePairingToken } from "./pairing-token-DzfCmsrM.js";
import { i as isSecureWebSocketUrl, p as rawDataToString } from "./net-DBrsyv8q.js";
import path from "node:path";
import fs from "node:fs";
import crypto, { randomUUID } from "node:crypto";
import AjvPkg from "ajv";
import { WebSocket as WebSocket$1 } from "ws";
import { Type } from "@sinclair/typebox";

//#region src/infra/device-identity.ts
function resolveDefaultIdentityPath() {
	return path.join(resolveStateDir(), "identity", "device.json");
}
function ensureDir(filePath) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
}
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
function base64UrlEncode(buf) {
	return buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}
function base64UrlDecode(input) {
	const normalized = input.replaceAll("-", "+").replaceAll("_", "/");
	const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
	return Buffer.from(padded, "base64");
}
function derivePublicKeyRaw(publicKeyPem) {
	const spki = crypto.createPublicKey(publicKeyPem).export({
		type: "spki",
		format: "der"
	});
	if (spki.length === ED25519_SPKI_PREFIX.length + 32 && spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)) return spki.subarray(ED25519_SPKI_PREFIX.length);
	return spki;
}
function fingerprintPublicKey(publicKeyPem) {
	const raw = derivePublicKeyRaw(publicKeyPem);
	return crypto.createHash("sha256").update(raw).digest("hex");
}
function generateIdentity() {
	const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
	const publicKeyPem = publicKey.export({
		type: "spki",
		format: "pem"
	}).toString();
	const privateKeyPem = privateKey.export({
		type: "pkcs8",
		format: "pem"
	}).toString();
	return {
		deviceId: fingerprintPublicKey(publicKeyPem),
		publicKeyPem,
		privateKeyPem
	};
}
function loadOrCreateDeviceIdentity(filePath = resolveDefaultIdentityPath()) {
	try {
		if (fs.existsSync(filePath)) {
			const raw = fs.readFileSync(filePath, "utf8");
			const parsed = JSON.parse(raw);
			if (parsed?.version === 1 && typeof parsed.deviceId === "string" && typeof parsed.publicKeyPem === "string" && typeof parsed.privateKeyPem === "string") {
				const derivedId = fingerprintPublicKey(parsed.publicKeyPem);
				if (derivedId && derivedId !== parsed.deviceId) {
					const updated = {
						...parsed,
						deviceId: derivedId
					};
					fs.writeFileSync(filePath, `${JSON.stringify(updated, null, 2)}\n`, { mode: 384 });
					try {
						fs.chmodSync(filePath, 384);
					} catch {}
					return {
						deviceId: derivedId,
						publicKeyPem: parsed.publicKeyPem,
						privateKeyPem: parsed.privateKeyPem
					};
				}
				return {
					deviceId: parsed.deviceId,
					publicKeyPem: parsed.publicKeyPem,
					privateKeyPem: parsed.privateKeyPem
				};
			}
		}
	} catch {}
	const identity = generateIdentity();
	ensureDir(filePath);
	const stored = {
		version: 1,
		deviceId: identity.deviceId,
		publicKeyPem: identity.publicKeyPem,
		privateKeyPem: identity.privateKeyPem,
		createdAtMs: Date.now()
	};
	fs.writeFileSync(filePath, `${JSON.stringify(stored, null, 2)}\n`, { mode: 384 });
	try {
		fs.chmodSync(filePath, 384);
	} catch {}
	return identity;
}
function signDevicePayload(privateKeyPem, payload) {
	const key = crypto.createPrivateKey(privateKeyPem);
	return base64UrlEncode(crypto.sign(null, Buffer.from(payload, "utf8"), key));
}
function normalizeDevicePublicKeyBase64Url(publicKey) {
	try {
		if (publicKey.includes("BEGIN")) return base64UrlEncode(derivePublicKeyRaw(publicKey));
		return base64UrlEncode(base64UrlDecode(publicKey));
	} catch {
		return null;
	}
}
function deriveDeviceIdFromPublicKey(publicKey) {
	try {
		const raw = publicKey.includes("BEGIN") ? derivePublicKeyRaw(publicKey) : base64UrlDecode(publicKey);
		return crypto.createHash("sha256").update(raw).digest("hex");
	} catch {
		return null;
	}
}
function publicKeyRawBase64UrlFromPem(publicKeyPem) {
	return base64UrlEncode(derivePublicKeyRaw(publicKeyPem));
}
function verifyDeviceSignature(publicKey, payload, signatureBase64Url) {
	try {
		const key = publicKey.includes("BEGIN") ? crypto.createPublicKey(publicKey) : crypto.createPublicKey({
			key: Buffer.concat([ED25519_SPKI_PREFIX, base64UrlDecode(publicKey)]),
			type: "spki",
			format: "der"
		});
		const sig = (() => {
			try {
				return base64UrlDecode(signatureBase64Url);
			} catch {
				return Buffer.from(signatureBase64Url, "base64");
			}
		})();
		return crypto.verify(null, Buffer.from(payload, "utf8"), key, sig);
	} catch {
		return false;
	}
}

//#endregion
//#region src/infra/tls/fingerprint.ts
function normalizeFingerprint(input) {
	return input.trim().replace(/^sha-?256\s*:?\s*/i, "").replace(/[^a-fA-F0-9]/g, "").toLowerCase();
}

//#endregion
//#region src/shared/device-auth.ts
function normalizeDeviceAuthRole(role) {
	return role.trim();
}
function normalizeDeviceAuthScopes(scopes) {
	if (!Array.isArray(scopes)) return [];
	const out = /* @__PURE__ */ new Set();
	for (const scope of scopes) {
		const trimmed = scope.trim();
		if (trimmed) out.add(trimmed);
	}
	return [...out].toSorted();
}

//#endregion
//#region src/infra/device-auth-store.ts
const DEVICE_AUTH_FILE = "device-auth.json";
function resolveDeviceAuthPath(env = process.env) {
	return path.join(resolveStateDir(env), "identity", DEVICE_AUTH_FILE);
}
function readStore(filePath) {
	try {
		if (!fs.existsSync(filePath)) return null;
		const raw = fs.readFileSync(filePath, "utf8");
		const parsed = JSON.parse(raw);
		if (parsed?.version !== 1 || typeof parsed.deviceId !== "string") return null;
		if (!parsed.tokens || typeof parsed.tokens !== "object") return null;
		return parsed;
	} catch {
		return null;
	}
}
function writeStore(filePath, store) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, `${JSON.stringify(store, null, 2)}\n`, { mode: 384 });
	try {
		fs.chmodSync(filePath, 384);
	} catch {}
}
function loadDeviceAuthToken(params) {
	const store = readStore(resolveDeviceAuthPath(params.env));
	if (!store) return null;
	if (store.deviceId !== params.deviceId) return null;
	const role = normalizeDeviceAuthRole(params.role);
	const entry = store.tokens[role];
	if (!entry || typeof entry.token !== "string") return null;
	return entry;
}
function storeDeviceAuthToken(params) {
	const filePath = resolveDeviceAuthPath(params.env);
	const existing = readStore(filePath);
	const role = normalizeDeviceAuthRole(params.role);
	const next = {
		version: 1,
		deviceId: params.deviceId,
		tokens: existing && existing.deviceId === params.deviceId && existing.tokens ? { ...existing.tokens } : {}
	};
	const entry = {
		token: params.token,
		role,
		scopes: normalizeDeviceAuthScopes(params.scopes),
		updatedAtMs: Date.now()
	};
	next.tokens[role] = entry;
	writeStore(filePath, next);
	return entry;
}
function clearDeviceAuthToken(params) {
	const filePath = resolveDeviceAuthPath(params.env);
	const store = readStore(filePath);
	if (!store || store.deviceId !== params.deviceId) return;
	const role = normalizeDeviceAuthRole(params.role);
	if (!store.tokens[role]) return;
	const next = {
		version: 1,
		deviceId: store.deviceId,
		tokens: { ...store.tokens }
	};
	delete next.tokens[role];
	writeStore(filePath, next);
}

//#endregion
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
function scopesAllow(requested, allowed) {
	if (requested.length === 0) return true;
	if (allowed.length === 0) return false;
	const allowedSet = new Set(allowed);
	return requested.every((scope) => allowedSet.has(scope));
}
const DEVICE_SCOPE_IMPLICATIONS = {
	"operator.admin": [
		"operator.read",
		"operator.write",
		"operator.approvals",
		"operator.pairing"
	],
	"operator.write": ["operator.read"]
};
function expandScopeImplications(scopes) {
	const expanded = new Set(scopes);
	const queue = [...scopes];
	while (queue.length > 0) {
		const scope = queue.pop();
		if (!scope) continue;
		for (const impliedScope of DEVICE_SCOPE_IMPLICATIONS[scope] ?? []) if (!expanded.has(impliedScope)) {
			expanded.add(impliedScope);
			queue.push(impliedScope);
		}
	}
	return [...expanded];
}
function scopesAllowWithImplications(requested, allowed) {
	return scopesAllow(expandScopeImplications(requested), expandScopeImplications(allowed));
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
		if (!deviceId) throw new Error("deviceId required");
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
async function approveDevicePairing(requestId, baseDir) {
	return await withLock(async () => {
		const state = await loadState(baseDir);
		const pending = state.pendingById[requestId];
		if (!pending) return null;
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
		if (!normalized || !state.pairedByDeviceId[normalized]) return null;
		delete state.pairedByDeviceId[normalized];
		await persistState(state, baseDir);
		return { deviceId: normalized };
	});
}
async function updatePairedDeviceMetadata(deviceId, patch, baseDir) {
	return await withLock(async () => {
		const state = await loadState(baseDir);
		const existing = state.pairedByDeviceId[normalizeDeviceId(deviceId)];
		if (!existing) return;
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
	if (!tokens) return;
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
		if (!device) return {
			ok: false,
			reason: "device-not-paired"
		};
		const role = normalizeRole(params.role);
		if (!role) return {
			ok: false,
			reason: "role-missing"
		};
		const entry = device.tokens?.[role];
		if (!entry) return {
			ok: false,
			reason: "token-missing"
		};
		if (entry.revokedAtMs) return {
			ok: false,
			reason: "token-revoked"
		};
		if (!verifyPairingToken(params.token, entry.token)) return {
			ok: false,
			reason: "token-mismatch"
		};
		if (!roleScopesAllow({
			role,
			requestedScopes: normalizeDeviceAuthScopes(params.scopes),
			allowedScopes: entry.scopes
		})) return {
			ok: false,
			reason: "scope-mismatch"
		};
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
		if (!context) return null;
		const { device, role, tokens, existing } = context;
		if (existing && !existing.revokedAtMs) {
			if (roleScopesAllow({
				role,
				requestedScopes,
				allowedScopes: existing.scopes
			})) return existing;
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
	if (!device) return null;
	const role = normalizeRole(params.role);
	if (!role) return null;
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
		if (!context) return null;
		const { device, role, tokens, existing } = context;
		const requestedScopes = normalizeDeviceAuthScopes(params.scopes ?? existing?.scopes ?? device.scopes);
		if (!scopesAllowWithImplications(requestedScopes, normalizeDeviceAuthScopes(device.approvedScopes ?? device.scopes ?? existing?.scopes))) return null;
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
		return next;
	});
}
async function revokeDeviceToken(params) {
	return await withLock(async () => {
		const state = await loadState(params.baseDir);
		const device = state.pairedByDeviceId[normalizeDeviceId(params.deviceId)];
		if (!device) return null;
		const role = normalizeRole(params.role);
		if (!role) return null;
		if (!device.tokens?.[role]) return null;
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
async function clearDevicePairing(deviceId, baseDir) {
	return await withLock(async () => {
		const state = await loadState(baseDir);
		const normalizedId = normalizeDeviceId(deviceId);
		if (!state.pairedByDeviceId[normalizedId]) return false;
		delete state.pairedByDeviceId[normalizedId];
		await persistState(state, baseDir);
		return true;
	});
}

//#endregion
//#region src/gateway/device-auth.ts
function toLowerAscii(input) {
	return input.replace(/[A-Z]/g, (char) => String.fromCharCode(char.charCodeAt(0) + 32));
}
function normalizeDeviceMetadataForAuth(value) {
	if (typeof value !== "string") return "";
	const trimmed = value.trim();
	if (!trimmed) return "";
	return toLowerAscii(trimmed);
}
function buildDeviceAuthPayload(params) {
	const scopes = params.scopes.join(",");
	const token = params.token ?? "";
	return [
		"v2",
		params.deviceId,
		params.clientId,
		params.clientMode,
		params.role,
		scopes,
		String(params.signedAtMs),
		token,
		params.nonce
	].join("|");
}
function buildDeviceAuthPayloadV3(params) {
	const scopes = params.scopes.join(",");
	const token = params.token ?? "";
	const platform = normalizeDeviceMetadataForAuth(params.platform);
	const deviceFamily = normalizeDeviceMetadataForAuth(params.deviceFamily);
	return [
		"v3",
		params.deviceId,
		params.clientId,
		params.clientMode,
		params.role,
		scopes,
		String(params.signedAtMs),
		token,
		params.nonce,
		platform,
		deviceFamily
	].join("|");
}

//#endregion
//#region src/sessions/session-label.ts
const SESSION_LABEL_MAX_LENGTH = 64;
function parseSessionLabel(raw) {
	if (typeof raw !== "string") return {
		ok: false,
		error: "invalid label: must be a string"
	};
	const trimmed = raw.trim();
	if (!trimmed) return {
		ok: false,
		error: "invalid label: empty"
	};
	if (trimmed.length > SESSION_LABEL_MAX_LENGTH) return {
		ok: false,
		error: `invalid label: too long (max ${SESSION_LABEL_MAX_LENGTH})`
	};
	return {
		ok: true,
		label: trimmed
	};
}

//#endregion
//#region src/gateway/protocol/schema/primitives.ts
const NonEmptyString = Type.String({ minLength: 1 });
const SessionLabelString = Type.String({
	minLength: 1,
	maxLength: SESSION_LABEL_MAX_LENGTH
});
const GatewayClientIdSchema = Type.Union(Object.values(GATEWAY_CLIENT_IDS).map((value) => Type.Literal(value)));
const GatewayClientModeSchema = Type.Union(Object.values(GATEWAY_CLIENT_MODES).map((value) => Type.Literal(value)));

//#endregion
//#region src/gateway/protocol/schema/agent.ts
const AgentEventSchema = Type.Object({
	runId: NonEmptyString,
	seq: Type.Integer({ minimum: 0 }),
	stream: NonEmptyString,
	ts: Type.Integer({ minimum: 0 }),
	data: Type.Record(Type.String(), Type.Unknown())
}, { additionalProperties: false });
const SendParamsSchema = Type.Object({
	to: NonEmptyString,
	message: Type.Optional(Type.String()),
	mediaUrl: Type.Optional(Type.String()),
	mediaUrls: Type.Optional(Type.Array(Type.String())),
	gifPlayback: Type.Optional(Type.Boolean()),
	channel: Type.Optional(Type.String()),
	accountId: Type.Optional(Type.String()),
	agentId: Type.Optional(Type.String()),
	threadId: Type.Optional(Type.String()),
	sessionKey: Type.Optional(Type.String()),
	idempotencyKey: NonEmptyString
}, { additionalProperties: false });
const PollParamsSchema = Type.Object({
	to: NonEmptyString,
	question: NonEmptyString,
	options: Type.Array(NonEmptyString, {
		minItems: 2,
		maxItems: 12
	}),
	maxSelections: Type.Optional(Type.Integer({
		minimum: 1,
		maximum: 12
	})),
	durationSeconds: Type.Optional(Type.Integer({
		minimum: 1,
		maximum: 604800
	})),
	durationHours: Type.Optional(Type.Integer({ minimum: 1 })),
	silent: Type.Optional(Type.Boolean()),
	isAnonymous: Type.Optional(Type.Boolean()),
	threadId: Type.Optional(Type.String()),
	channel: Type.Optional(Type.String()),
	accountId: Type.Optional(Type.String()),
	idempotencyKey: NonEmptyString
}, { additionalProperties: false });
const AgentParamsSchema = Type.Object({
	message: NonEmptyString,
	agentId: Type.Optional(NonEmptyString),
	to: Type.Optional(Type.String()),
	replyTo: Type.Optional(Type.String()),
	sessionId: Type.Optional(Type.String()),
	sessionKey: Type.Optional(Type.String()),
	thinking: Type.Optional(Type.String()),
	deliver: Type.Optional(Type.Boolean()),
	attachments: Type.Optional(Type.Array(Type.Unknown())),
	channel: Type.Optional(Type.String()),
	replyChannel: Type.Optional(Type.String()),
	accountId: Type.Optional(Type.String()),
	replyAccountId: Type.Optional(Type.String()),
	threadId: Type.Optional(Type.String()),
	groupId: Type.Optional(Type.String()),
	groupChannel: Type.Optional(Type.String()),
	groupSpace: Type.Optional(Type.String()),
	timeout: Type.Optional(Type.Integer({ minimum: 0 })),
	bestEffortDeliver: Type.Optional(Type.Boolean()),
	lane: Type.Optional(Type.String()),
	extraSystemPrompt: Type.Optional(Type.String()),
	inputProvenance: Type.Optional(Type.Object({
		kind: Type.String({ enum: [...INPUT_PROVENANCE_KIND_VALUES] }),
		sourceSessionKey: Type.Optional(Type.String()),
		sourceChannel: Type.Optional(Type.String()),
		sourceTool: Type.Optional(Type.String())
	}, { additionalProperties: false })),
	idempotencyKey: NonEmptyString,
	label: Type.Optional(SessionLabelString),
	spawnedBy: Type.Optional(Type.String())
}, { additionalProperties: false });
const AgentIdentityParamsSchema = Type.Object({
	agentId: Type.Optional(NonEmptyString),
	sessionKey: Type.Optional(Type.String())
}, { additionalProperties: false });
const AgentIdentityResultSchema = Type.Object({
	agentId: NonEmptyString,
	name: Type.Optional(NonEmptyString),
	avatar: Type.Optional(NonEmptyString),
	emoji: Type.Optional(NonEmptyString)
}, { additionalProperties: false });
const AgentWaitParamsSchema = Type.Object({
	runId: NonEmptyString,
	timeoutMs: Type.Optional(Type.Integer({ minimum: 0 }))
}, { additionalProperties: false });
const WakeParamsSchema = Type.Object({
	mode: Type.Union([Type.Literal("now"), Type.Literal("next-heartbeat")]),
	text: NonEmptyString
}, { additionalProperties: false });

//#endregion
//#region src/gateway/protocol/schema/agents-models-skills.ts
const ModelChoiceSchema = Type.Object({
	id: NonEmptyString,
	name: NonEmptyString,
	provider: NonEmptyString,
	contextWindow: Type.Optional(Type.Integer({ minimum: 1 })),
	reasoning: Type.Optional(Type.Boolean())
}, { additionalProperties: false });
const AgentSummarySchema = Type.Object({
	id: NonEmptyString,
	name: Type.Optional(NonEmptyString),
	identity: Type.Optional(Type.Object({
		name: Type.Optional(NonEmptyString),
		theme: Type.Optional(NonEmptyString),
		emoji: Type.Optional(NonEmptyString),
		avatar: Type.Optional(NonEmptyString),
		avatarUrl: Type.Optional(NonEmptyString)
	}, { additionalProperties: false }))
}, { additionalProperties: false });
const AgentsListParamsSchema = Type.Object({}, { additionalProperties: false });
const AgentsListResultSchema = Type.Object({
	defaultId: NonEmptyString,
	mainKey: NonEmptyString,
	scope: Type.Union([Type.Literal("per-sender"), Type.Literal("global")]),
	agents: Type.Array(AgentSummarySchema)
}, { additionalProperties: false });
const AgentsCreateParamsSchema = Type.Object({
	name: NonEmptyString,
	workspace: NonEmptyString,
	emoji: Type.Optional(Type.String()),
	avatar: Type.Optional(Type.String())
}, { additionalProperties: false });
const AgentsCreateResultSchema = Type.Object({
	ok: Type.Literal(true),
	agentId: NonEmptyString,
	name: NonEmptyString,
	workspace: NonEmptyString
}, { additionalProperties: false });
const AgentsUpdateParamsSchema = Type.Object({
	agentId: NonEmptyString,
	name: Type.Optional(NonEmptyString),
	workspace: Type.Optional(NonEmptyString),
	model: Type.Optional(NonEmptyString),
	avatar: Type.Optional(Type.String())
}, { additionalProperties: false });
const AgentsUpdateResultSchema = Type.Object({
	ok: Type.Literal(true),
	agentId: NonEmptyString
}, { additionalProperties: false });
const AgentsDeleteParamsSchema = Type.Object({
	agentId: NonEmptyString,
	deleteFiles: Type.Optional(Type.Boolean())
}, { additionalProperties: false });
const AgentsDeleteResultSchema = Type.Object({
	ok: Type.Literal(true),
	agentId: NonEmptyString,
	removedBindings: Type.Integer({ minimum: 0 })
}, { additionalProperties: false });
const AgentsFileEntrySchema = Type.Object({
	name: NonEmptyString,
	path: NonEmptyString,
	missing: Type.Boolean(),
	size: Type.Optional(Type.Integer({ minimum: 0 })),
	updatedAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
	content: Type.Optional(Type.String())
}, { additionalProperties: false });
const AgentsFilesListParamsSchema = Type.Object({ agentId: NonEmptyString }, { additionalProperties: false });
const AgentsFilesListResultSchema = Type.Object({
	agentId: NonEmptyString,
	workspace: NonEmptyString,
	files: Type.Array(AgentsFileEntrySchema)
}, { additionalProperties: false });
const AgentsFilesGetParamsSchema = Type.Object({
	agentId: NonEmptyString,
	name: NonEmptyString
}, { additionalProperties: false });
const AgentsFilesGetResultSchema = Type.Object({
	agentId: NonEmptyString,
	workspace: NonEmptyString,
	file: AgentsFileEntrySchema
}, { additionalProperties: false });
const AgentsFilesSetParamsSchema = Type.Object({
	agentId: NonEmptyString,
	name: NonEmptyString,
	content: Type.String()
}, { additionalProperties: false });
const AgentsFilesSetResultSchema = Type.Object({
	ok: Type.Literal(true),
	agentId: NonEmptyString,
	workspace: NonEmptyString,
	file: AgentsFileEntrySchema
}, { additionalProperties: false });
const ModelsListParamsSchema = Type.Object({}, { additionalProperties: false });
const ModelsListResultSchema = Type.Object({ models: Type.Array(ModelChoiceSchema) }, { additionalProperties: false });
const SkillsStatusParamsSchema = Type.Object({ agentId: Type.Optional(NonEmptyString) }, { additionalProperties: false });
const SkillsBinsParamsSchema = Type.Object({}, { additionalProperties: false });
const SkillsBinsResultSchema = Type.Object({ bins: Type.Array(NonEmptyString) }, { additionalProperties: false });
const SkillsInstallParamsSchema = Type.Object({
	name: NonEmptyString,
	installId: NonEmptyString,
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1e3 }))
}, { additionalProperties: false });
const SkillsUpdateParamsSchema = Type.Object({
	skillKey: NonEmptyString,
	enabled: Type.Optional(Type.Boolean()),
	apiKey: Type.Optional(Type.String()),
	env: Type.Optional(Type.Record(NonEmptyString, Type.String()))
}, { additionalProperties: false });
const ToolsCatalogParamsSchema = Type.Object({
	agentId: Type.Optional(NonEmptyString),
	includePlugins: Type.Optional(Type.Boolean())
}, { additionalProperties: false });
const ToolCatalogProfileSchema = Type.Object({
	id: Type.Union([
		Type.Literal("minimal"),
		Type.Literal("coding"),
		Type.Literal("messaging"),
		Type.Literal("full")
	]),
	label: NonEmptyString
}, { additionalProperties: false });
const ToolCatalogEntrySchema = Type.Object({
	id: NonEmptyString,
	label: NonEmptyString,
	description: Type.String(),
	source: Type.Union([Type.Literal("core"), Type.Literal("plugin")]),
	pluginId: Type.Optional(NonEmptyString),
	optional: Type.Optional(Type.Boolean()),
	defaultProfiles: Type.Array(Type.Union([
		Type.Literal("minimal"),
		Type.Literal("coding"),
		Type.Literal("messaging"),
		Type.Literal("full")
	]))
}, { additionalProperties: false });
const ToolCatalogGroupSchema = Type.Object({
	id: NonEmptyString,
	label: NonEmptyString,
	source: Type.Union([Type.Literal("core"), Type.Literal("plugin")]),
	pluginId: Type.Optional(NonEmptyString),
	tools: Type.Array(ToolCatalogEntrySchema)
}, { additionalProperties: false });
const ToolsCatalogResultSchema = Type.Object({
	agentId: NonEmptyString,
	profiles: Type.Array(ToolCatalogProfileSchema),
	groups: Type.Array(ToolCatalogGroupSchema)
}, { additionalProperties: false });

//#endregion
//#region src/gateway/protocol/schema/channels.ts
const TalkModeParamsSchema = Type.Object({
	enabled: Type.Boolean(),
	phase: Type.Optional(Type.String())
}, { additionalProperties: false });
const TalkConfigParamsSchema = Type.Object({ includeSecrets: Type.Optional(Type.Boolean()) }, { additionalProperties: false });
const TalkProviderConfigSchema = Type.Object({
	voiceId: Type.Optional(Type.String()),
	voiceAliases: Type.Optional(Type.Record(Type.String(), Type.String())),
	modelId: Type.Optional(Type.String()),
	outputFormat: Type.Optional(Type.String()),
	apiKey: Type.Optional(Type.String())
}, { additionalProperties: true });
const TalkConfigResultSchema = Type.Object({ config: Type.Object({
	talk: Type.Optional(Type.Object({
		provider: Type.Optional(Type.String()),
		providers: Type.Optional(Type.Record(Type.String(), TalkProviderConfigSchema)),
		voiceId: Type.Optional(Type.String()),
		voiceAliases: Type.Optional(Type.Record(Type.String(), Type.String())),
		modelId: Type.Optional(Type.String()),
		outputFormat: Type.Optional(Type.String()),
		apiKey: Type.Optional(Type.String()),
		interruptOnSpeech: Type.Optional(Type.Boolean())
	}, { additionalProperties: false })),
	session: Type.Optional(Type.Object({ mainKey: Type.Optional(Type.String()) }, { additionalProperties: false })),
	ui: Type.Optional(Type.Object({ seamColor: Type.Optional(Type.String()) }, { additionalProperties: false }))
}, { additionalProperties: false }) }, { additionalProperties: false });
const ChannelsStatusParamsSchema = Type.Object({
	probe: Type.Optional(Type.Boolean()),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 0 }))
}, { additionalProperties: false });
const ChannelAccountSnapshotSchema = Type.Object({
	accountId: NonEmptyString,
	name: Type.Optional(Type.String()),
	enabled: Type.Optional(Type.Boolean()),
	configured: Type.Optional(Type.Boolean()),
	linked: Type.Optional(Type.Boolean()),
	running: Type.Optional(Type.Boolean()),
	connected: Type.Optional(Type.Boolean()),
	reconnectAttempts: Type.Optional(Type.Integer({ minimum: 0 })),
	lastConnectedAt: Type.Optional(Type.Integer({ minimum: 0 })),
	lastError: Type.Optional(Type.String()),
	lastStartAt: Type.Optional(Type.Integer({ minimum: 0 })),
	lastStopAt: Type.Optional(Type.Integer({ minimum: 0 })),
	lastInboundAt: Type.Optional(Type.Integer({ minimum: 0 })),
	lastOutboundAt: Type.Optional(Type.Integer({ minimum: 0 })),
	lastProbeAt: Type.Optional(Type.Integer({ minimum: 0 })),
	mode: Type.Optional(Type.String()),
	dmPolicy: Type.Optional(Type.String()),
	allowFrom: Type.Optional(Type.Array(Type.String())),
	tokenSource: Type.Optional(Type.String()),
	botTokenSource: Type.Optional(Type.String()),
	appTokenSource: Type.Optional(Type.String()),
	baseUrl: Type.Optional(Type.String()),
	allowUnmentionedGroups: Type.Optional(Type.Boolean()),
	cliPath: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	dbPath: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	port: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
	probe: Type.Optional(Type.Unknown()),
	audit: Type.Optional(Type.Unknown()),
	application: Type.Optional(Type.Unknown())
}, { additionalProperties: true });
const ChannelUiMetaSchema = Type.Object({
	id: NonEmptyString,
	label: NonEmptyString,
	detailLabel: NonEmptyString,
	systemImage: Type.Optional(Type.String())
}, { additionalProperties: false });
const ChannelsStatusResultSchema = Type.Object({
	ts: Type.Integer({ minimum: 0 }),
	channelOrder: Type.Array(NonEmptyString),
	channelLabels: Type.Record(NonEmptyString, NonEmptyString),
	channelDetailLabels: Type.Optional(Type.Record(NonEmptyString, NonEmptyString)),
	channelSystemImages: Type.Optional(Type.Record(NonEmptyString, NonEmptyString)),
	channelMeta: Type.Optional(Type.Array(ChannelUiMetaSchema)),
	channels: Type.Record(NonEmptyString, Type.Unknown()),
	channelAccounts: Type.Record(NonEmptyString, Type.Array(ChannelAccountSnapshotSchema)),
	channelDefaultAccountId: Type.Record(NonEmptyString, NonEmptyString)
}, { additionalProperties: false });
const ChannelsLogoutParamsSchema = Type.Object({
	channel: NonEmptyString,
	accountId: Type.Optional(Type.String())
}, { additionalProperties: false });
const WebLoginStartParamsSchema = Type.Object({
	force: Type.Optional(Type.Boolean()),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
	verbose: Type.Optional(Type.Boolean()),
	accountId: Type.Optional(Type.String())
}, { additionalProperties: false });
const WebLoginWaitParamsSchema = Type.Object({
	timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
	accountId: Type.Optional(Type.String())
}, { additionalProperties: false });

//#endregion
//#region src/gateway/protocol/schema/config.ts
const ConfigGetParamsSchema = Type.Object({}, { additionalProperties: false });
const ConfigSetParamsSchema = Type.Object({
	raw: NonEmptyString,
	baseHash: Type.Optional(NonEmptyString)
}, { additionalProperties: false });
const ConfigApplyLikeParamsSchema = Type.Object({
	raw: NonEmptyString,
	baseHash: Type.Optional(NonEmptyString),
	sessionKey: Type.Optional(Type.String()),
	note: Type.Optional(Type.String()),
	restartDelayMs: Type.Optional(Type.Integer({ minimum: 0 }))
}, { additionalProperties: false });
const ConfigApplyParamsSchema = ConfigApplyLikeParamsSchema;
const ConfigPatchParamsSchema = ConfigApplyLikeParamsSchema;
const ConfigSchemaParamsSchema = Type.Object({}, { additionalProperties: false });
const UpdateRunParamsSchema = Type.Object({
	sessionKey: Type.Optional(Type.String()),
	note: Type.Optional(Type.String()),
	restartDelayMs: Type.Optional(Type.Integer({ minimum: 0 })),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1 }))
}, { additionalProperties: false });
const ConfigUiHintSchema = Type.Object({
	label: Type.Optional(Type.String()),
	help: Type.Optional(Type.String()),
	tags: Type.Optional(Type.Array(Type.String())),
	group: Type.Optional(Type.String()),
	order: Type.Optional(Type.Integer()),
	advanced: Type.Optional(Type.Boolean()),
	sensitive: Type.Optional(Type.Boolean()),
	placeholder: Type.Optional(Type.String()),
	itemTemplate: Type.Optional(Type.Unknown())
}, { additionalProperties: false });
const ConfigSchemaResponseSchema = Type.Object({
	schema: Type.Unknown(),
	uiHints: Type.Record(Type.String(), ConfigUiHintSchema),
	version: NonEmptyString,
	generatedAt: NonEmptyString
}, { additionalProperties: false });

//#endregion
//#region src/gateway/protocol/schema/cron.ts
function cronAgentTurnPayloadSchema(params) {
	return Type.Object({
		kind: Type.Literal("agentTurn"),
		message: params.message,
		model: Type.Optional(Type.String()),
		thinking: Type.Optional(Type.String()),
		timeoutSeconds: Type.Optional(Type.Integer({ minimum: 0 })),
		allowUnsafeExternalContent: Type.Optional(Type.Boolean()),
		deliver: Type.Optional(Type.Boolean()),
		channel: Type.Optional(Type.String()),
		to: Type.Optional(Type.String()),
		bestEffortDeliver: Type.Optional(Type.Boolean())
	}, { additionalProperties: false });
}
const CronSessionTargetSchema = Type.Union([Type.Literal("main"), Type.Literal("isolated")]);
const CronWakeModeSchema = Type.Union([Type.Literal("next-heartbeat"), Type.Literal("now")]);
const CronRunStatusSchema = Type.Union([
	Type.Literal("ok"),
	Type.Literal("error"),
	Type.Literal("skipped")
]);
const CronSortDirSchema = Type.Union([Type.Literal("asc"), Type.Literal("desc")]);
const CronJobsEnabledFilterSchema = Type.Union([
	Type.Literal("all"),
	Type.Literal("enabled"),
	Type.Literal("disabled")
]);
const CronJobsSortBySchema = Type.Union([
	Type.Literal("nextRunAtMs"),
	Type.Literal("updatedAtMs"),
	Type.Literal("name")
]);
const CronRunsStatusFilterSchema = Type.Union([
	Type.Literal("all"),
	Type.Literal("ok"),
	Type.Literal("error"),
	Type.Literal("skipped")
]);
const CronRunsStatusValueSchema = Type.Union([
	Type.Literal("ok"),
	Type.Literal("error"),
	Type.Literal("skipped")
]);
const CronDeliveryStatusSchema = Type.Union([
	Type.Literal("delivered"),
	Type.Literal("not-delivered"),
	Type.Literal("unknown"),
	Type.Literal("not-requested")
]);
const CronCommonOptionalFields = {
	agentId: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
	sessionKey: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
	description: Type.Optional(Type.String()),
	enabled: Type.Optional(Type.Boolean()),
	deleteAfterRun: Type.Optional(Type.Boolean())
};
function cronIdOrJobIdParams(extraFields) {
	return Type.Union([Type.Object({
		id: NonEmptyString,
		...extraFields
	}, { additionalProperties: false }), Type.Object({
		jobId: NonEmptyString,
		...extraFields
	}, { additionalProperties: false })]);
}
const CronRunLogJobIdSchema = Type.String({
	minLength: 1,
	pattern: "^[^/\\\\]+$"
});
const CronScheduleSchema = Type.Union([
	Type.Object({
		kind: Type.Literal("at"),
		at: NonEmptyString
	}, { additionalProperties: false }),
	Type.Object({
		kind: Type.Literal("every"),
		everyMs: Type.Integer({ minimum: 1 }),
		anchorMs: Type.Optional(Type.Integer({ minimum: 0 }))
	}, { additionalProperties: false }),
	Type.Object({
		kind: Type.Literal("cron"),
		expr: NonEmptyString,
		tz: Type.Optional(Type.String()),
		staggerMs: Type.Optional(Type.Integer({ minimum: 0 }))
	}, { additionalProperties: false })
]);
const CronPayloadSchema = Type.Union([Type.Object({
	kind: Type.Literal("systemEvent"),
	text: NonEmptyString
}, { additionalProperties: false }), cronAgentTurnPayloadSchema({ message: NonEmptyString })]);
const CronPayloadPatchSchema = Type.Union([Type.Object({
	kind: Type.Literal("systemEvent"),
	text: Type.Optional(NonEmptyString)
}, { additionalProperties: false }), cronAgentTurnPayloadSchema({ message: Type.Optional(NonEmptyString) })]);
const CronDeliverySharedProperties = {
	channel: Type.Optional(Type.Union([Type.Literal("last"), NonEmptyString])),
	accountId: Type.Optional(NonEmptyString),
	bestEffort: Type.Optional(Type.Boolean())
};
const CronDeliveryNoopSchema = Type.Object({
	mode: Type.Literal("none"),
	...CronDeliverySharedProperties,
	to: Type.Optional(Type.String())
}, { additionalProperties: false });
const CronDeliveryAnnounceSchema = Type.Object({
	mode: Type.Literal("announce"),
	...CronDeliverySharedProperties,
	to: Type.Optional(Type.String())
}, { additionalProperties: false });
const CronDeliveryWebhookSchema = Type.Object({
	mode: Type.Literal("webhook"),
	...CronDeliverySharedProperties,
	to: NonEmptyString
}, { additionalProperties: false });
const CronDeliverySchema = Type.Union([
	CronDeliveryNoopSchema,
	CronDeliveryAnnounceSchema,
	CronDeliveryWebhookSchema
]);
const CronDeliveryPatchSchema = Type.Object({
	mode: Type.Optional(Type.Union([
		Type.Literal("none"),
		Type.Literal("announce"),
		Type.Literal("webhook")
	])),
	...CronDeliverySharedProperties,
	to: Type.Optional(Type.String())
}, { additionalProperties: false });
const CronJobStateSchema = Type.Object({
	nextRunAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
	runningAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
	lastRunAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
	lastRunStatus: Type.Optional(CronRunStatusSchema),
	lastStatus: Type.Optional(CronRunStatusSchema),
	lastError: Type.Optional(Type.String()),
	lastDurationMs: Type.Optional(Type.Integer({ minimum: 0 })),
	consecutiveErrors: Type.Optional(Type.Integer({ minimum: 0 })),
	lastDelivered: Type.Optional(Type.Boolean()),
	lastDeliveryStatus: Type.Optional(CronDeliveryStatusSchema),
	lastDeliveryError: Type.Optional(Type.String())
}, { additionalProperties: false });
const CronJobSchema = Type.Object({
	id: NonEmptyString,
	agentId: Type.Optional(NonEmptyString),
	sessionKey: Type.Optional(NonEmptyString),
	name: NonEmptyString,
	description: Type.Optional(Type.String()),
	enabled: Type.Boolean(),
	deleteAfterRun: Type.Optional(Type.Boolean()),
	createdAtMs: Type.Integer({ minimum: 0 }),
	updatedAtMs: Type.Integer({ minimum: 0 }),
	schedule: CronScheduleSchema,
	sessionTarget: CronSessionTargetSchema,
	wakeMode: CronWakeModeSchema,
	payload: CronPayloadSchema,
	delivery: Type.Optional(CronDeliverySchema),
	state: CronJobStateSchema
}, { additionalProperties: false });
const CronListParamsSchema = Type.Object({
	includeDisabled: Type.Optional(Type.Boolean()),
	limit: Type.Optional(Type.Integer({
		minimum: 1,
		maximum: 200
	})),
	offset: Type.Optional(Type.Integer({ minimum: 0 })),
	query: Type.Optional(Type.String()),
	enabled: Type.Optional(CronJobsEnabledFilterSchema),
	sortBy: Type.Optional(CronJobsSortBySchema),
	sortDir: Type.Optional(CronSortDirSchema)
}, { additionalProperties: false });
const CronStatusParamsSchema = Type.Object({}, { additionalProperties: false });
const CronAddParamsSchema = Type.Object({
	name: NonEmptyString,
	...CronCommonOptionalFields,
	schedule: CronScheduleSchema,
	sessionTarget: CronSessionTargetSchema,
	wakeMode: CronWakeModeSchema,
	payload: CronPayloadSchema,
	delivery: Type.Optional(CronDeliverySchema)
}, { additionalProperties: false });
const CronJobPatchSchema = Type.Object({
	name: Type.Optional(NonEmptyString),
	...CronCommonOptionalFields,
	schedule: Type.Optional(CronScheduleSchema),
	sessionTarget: Type.Optional(CronSessionTargetSchema),
	wakeMode: Type.Optional(CronWakeModeSchema),
	payload: Type.Optional(CronPayloadPatchSchema),
	delivery: Type.Optional(CronDeliveryPatchSchema),
	state: Type.Optional(Type.Partial(CronJobStateSchema))
}, { additionalProperties: false });
const CronUpdateParamsSchema = cronIdOrJobIdParams({ patch: CronJobPatchSchema });
const CronRemoveParamsSchema = cronIdOrJobIdParams({});
const CronRunParamsSchema = cronIdOrJobIdParams({ mode: Type.Optional(Type.Union([Type.Literal("due"), Type.Literal("force")])) });
const CronRunsParamsSchema = Type.Object({
	scope: Type.Optional(Type.Union([Type.Literal("job"), Type.Literal("all")])),
	id: Type.Optional(CronRunLogJobIdSchema),
	jobId: Type.Optional(CronRunLogJobIdSchema),
	limit: Type.Optional(Type.Integer({
		minimum: 1,
		maximum: 200
	})),
	offset: Type.Optional(Type.Integer({ minimum: 0 })),
	statuses: Type.Optional(Type.Array(CronRunsStatusValueSchema, {
		minItems: 1,
		maxItems: 3
	})),
	status: Type.Optional(CronRunsStatusFilterSchema),
	deliveryStatuses: Type.Optional(Type.Array(CronDeliveryStatusSchema, {
		minItems: 1,
		maxItems: 4
	})),
	deliveryStatus: Type.Optional(CronDeliveryStatusSchema),
	query: Type.Optional(Type.String()),
	sortDir: Type.Optional(CronSortDirSchema)
}, { additionalProperties: false });
const CronRunLogEntrySchema = Type.Object({
	ts: Type.Integer({ minimum: 0 }),
	jobId: NonEmptyString,
	action: Type.Literal("finished"),
	status: Type.Optional(CronRunStatusSchema),
	error: Type.Optional(Type.String()),
	summary: Type.Optional(Type.String()),
	delivered: Type.Optional(Type.Boolean()),
	deliveryStatus: Type.Optional(CronDeliveryStatusSchema),
	deliveryError: Type.Optional(Type.String()),
	sessionId: Type.Optional(NonEmptyString),
	sessionKey: Type.Optional(NonEmptyString),
	runAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
	durationMs: Type.Optional(Type.Integer({ minimum: 0 })),
	nextRunAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
	model: Type.Optional(Type.String()),
	provider: Type.Optional(Type.String()),
	usage: Type.Optional(Type.Object({
		input_tokens: Type.Optional(Type.Number()),
		output_tokens: Type.Optional(Type.Number()),
		total_tokens: Type.Optional(Type.Number()),
		cache_read_tokens: Type.Optional(Type.Number()),
		cache_write_tokens: Type.Optional(Type.Number())
	}, { additionalProperties: false })),
	jobName: Type.Optional(Type.String())
}, { additionalProperties: false });

//#endregion
//#region src/gateway/protocol/schema/error-codes.ts
const ErrorCodes = {
	NOT_LINKED: "NOT_LINKED",
	NOT_PAIRED: "NOT_PAIRED",
	AGENT_TIMEOUT: "AGENT_TIMEOUT",
	INVALID_REQUEST: "INVALID_REQUEST",
	UNAVAILABLE: "UNAVAILABLE"
};
function errorShape(code, message, opts) {
	return {
		code,
		message,
		...opts
	};
}

//#endregion
//#region src/gateway/protocol/schema/exec-approvals.ts
const ExecApprovalsAllowlistEntrySchema = Type.Object({
	id: Type.Optional(NonEmptyString),
	pattern: Type.String(),
	lastUsedAt: Type.Optional(Type.Integer({ minimum: 0 })),
	lastUsedCommand: Type.Optional(Type.String()),
	lastResolvedPath: Type.Optional(Type.String())
}, { additionalProperties: false });
const ExecApprovalsPolicyFields = {
	security: Type.Optional(Type.String()),
	ask: Type.Optional(Type.String()),
	askFallback: Type.Optional(Type.String()),
	autoAllowSkills: Type.Optional(Type.Boolean())
};
const ExecApprovalsDefaultsSchema = Type.Object(ExecApprovalsPolicyFields, { additionalProperties: false });
const ExecApprovalsAgentSchema = Type.Object({
	...ExecApprovalsPolicyFields,
	allowlist: Type.Optional(Type.Array(ExecApprovalsAllowlistEntrySchema))
}, { additionalProperties: false });
const ExecApprovalsFileSchema = Type.Object({
	version: Type.Literal(1),
	socket: Type.Optional(Type.Object({
		path: Type.Optional(Type.String()),
		token: Type.Optional(Type.String())
	}, { additionalProperties: false })),
	defaults: Type.Optional(ExecApprovalsDefaultsSchema),
	agents: Type.Optional(Type.Record(Type.String(), ExecApprovalsAgentSchema))
}, { additionalProperties: false });
const ExecApprovalsSnapshotSchema = Type.Object({
	path: NonEmptyString,
	exists: Type.Boolean(),
	hash: NonEmptyString,
	file: ExecApprovalsFileSchema
}, { additionalProperties: false });
const ExecApprovalsGetParamsSchema = Type.Object({}, { additionalProperties: false });
const ExecApprovalsSetParamsSchema = Type.Object({
	file: ExecApprovalsFileSchema,
	baseHash: Type.Optional(NonEmptyString)
}, { additionalProperties: false });
const ExecApprovalsNodeGetParamsSchema = Type.Object({ nodeId: NonEmptyString }, { additionalProperties: false });
const ExecApprovalsNodeSetParamsSchema = Type.Object({
	nodeId: NonEmptyString,
	file: ExecApprovalsFileSchema,
	baseHash: Type.Optional(NonEmptyString)
}, { additionalProperties: false });
const ExecApprovalRequestParamsSchema = Type.Object({
	id: Type.Optional(NonEmptyString),
	command: NonEmptyString,
	commandArgv: Type.Optional(Type.Array(Type.String())),
	systemRunPlanV2: Type.Optional(Type.Object({
		version: Type.Literal(2),
		argv: Type.Array(Type.String()),
		cwd: Type.Union([Type.String(), Type.Null()]),
		rawCommand: Type.Union([Type.String(), Type.Null()]),
		agentId: Type.Union([Type.String(), Type.Null()]),
		sessionKey: Type.Union([Type.String(), Type.Null()])
	}, { additionalProperties: false })),
	env: Type.Optional(Type.Record(NonEmptyString, Type.String())),
	cwd: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	nodeId: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
	host: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	security: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	ask: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	agentId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	resolvedPath: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	sessionKey: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	turnSourceChannel: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	turnSourceTo: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	turnSourceAccountId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	turnSourceThreadId: Type.Optional(Type.Union([
		Type.String(),
		Type.Number(),
		Type.Null()
	])),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
	twoPhase: Type.Optional(Type.Boolean())
}, { additionalProperties: false });
const ExecApprovalResolveParamsSchema = Type.Object({
	id: NonEmptyString,
	decision: NonEmptyString
}, { additionalProperties: false });

//#endregion
//#region src/gateway/protocol/schema/devices.ts
const DevicePairListParamsSchema = Type.Object({}, { additionalProperties: false });
const DevicePairApproveParamsSchema = Type.Object({ requestId: NonEmptyString }, { additionalProperties: false });
const DevicePairRejectParamsSchema = Type.Object({ requestId: NonEmptyString }, { additionalProperties: false });
const DevicePairRemoveParamsSchema = Type.Object({ deviceId: NonEmptyString }, { additionalProperties: false });
const DeviceTokenRotateParamsSchema = Type.Object({
	deviceId: NonEmptyString,
	role: NonEmptyString,
	scopes: Type.Optional(Type.Array(NonEmptyString))
}, { additionalProperties: false });
const DeviceTokenRevokeParamsSchema = Type.Object({
	deviceId: NonEmptyString,
	role: NonEmptyString
}, { additionalProperties: false });
const DevicePairRequestedEventSchema = Type.Object({
	requestId: NonEmptyString,
	deviceId: NonEmptyString,
	publicKey: NonEmptyString,
	displayName: Type.Optional(NonEmptyString),
	platform: Type.Optional(NonEmptyString),
	deviceFamily: Type.Optional(NonEmptyString),
	clientId: Type.Optional(NonEmptyString),
	clientMode: Type.Optional(NonEmptyString),
	role: Type.Optional(NonEmptyString),
	roles: Type.Optional(Type.Array(NonEmptyString)),
	scopes: Type.Optional(Type.Array(NonEmptyString)),
	remoteIp: Type.Optional(NonEmptyString),
	silent: Type.Optional(Type.Boolean()),
	isRepair: Type.Optional(Type.Boolean()),
	ts: Type.Integer({ minimum: 0 })
}, { additionalProperties: false });
const DevicePairResolvedEventSchema = Type.Object({
	requestId: NonEmptyString,
	deviceId: NonEmptyString,
	decision: NonEmptyString,
	ts: Type.Integer({ minimum: 0 })
}, { additionalProperties: false });

//#endregion
//#region src/gateway/protocol/schema/snapshot.ts
const PresenceEntrySchema = Type.Object({
	host: Type.Optional(NonEmptyString),
	ip: Type.Optional(NonEmptyString),
	version: Type.Optional(NonEmptyString),
	platform: Type.Optional(NonEmptyString),
	deviceFamily: Type.Optional(NonEmptyString),
	modelIdentifier: Type.Optional(NonEmptyString),
	mode: Type.Optional(NonEmptyString),
	lastInputSeconds: Type.Optional(Type.Integer({ minimum: 0 })),
	reason: Type.Optional(NonEmptyString),
	tags: Type.Optional(Type.Array(NonEmptyString)),
	text: Type.Optional(Type.String()),
	ts: Type.Integer({ minimum: 0 }),
	deviceId: Type.Optional(NonEmptyString),
	roles: Type.Optional(Type.Array(NonEmptyString)),
	scopes: Type.Optional(Type.Array(NonEmptyString)),
	instanceId: Type.Optional(NonEmptyString)
}, { additionalProperties: false });
const HealthSnapshotSchema = Type.Any();
const SessionDefaultsSchema = Type.Object({
	defaultAgentId: NonEmptyString,
	mainKey: NonEmptyString,
	mainSessionKey: NonEmptyString,
	scope: Type.Optional(NonEmptyString)
}, { additionalProperties: false });
const StateVersionSchema = Type.Object({
	presence: Type.Integer({ minimum: 0 }),
	health: Type.Integer({ minimum: 0 })
}, { additionalProperties: false });
const SnapshotSchema = Type.Object({
	presence: Type.Array(PresenceEntrySchema),
	health: HealthSnapshotSchema,
	stateVersion: StateVersionSchema,
	uptimeMs: Type.Integer({ minimum: 0 }),
	configPath: Type.Optional(NonEmptyString),
	stateDir: Type.Optional(NonEmptyString),
	sessionDefaults: Type.Optional(SessionDefaultsSchema),
	authMode: Type.Optional(Type.Union([
		Type.Literal("none"),
		Type.Literal("token"),
		Type.Literal("password"),
		Type.Literal("trusted-proxy")
	])),
	updateAvailable: Type.Optional(Type.Object({
		currentVersion: NonEmptyString,
		latestVersion: NonEmptyString,
		channel: NonEmptyString
	}))
}, { additionalProperties: false });

//#endregion
//#region src/gateway/protocol/schema/frames.ts
const TickEventSchema = Type.Object({ ts: Type.Integer({ minimum: 0 }) }, { additionalProperties: false });
const ShutdownEventSchema = Type.Object({
	reason: NonEmptyString,
	restartExpectedMs: Type.Optional(Type.Integer({ minimum: 0 }))
}, { additionalProperties: false });
const ConnectParamsSchema = Type.Object({
	minProtocol: Type.Integer({ minimum: 1 }),
	maxProtocol: Type.Integer({ minimum: 1 }),
	client: Type.Object({
		id: GatewayClientIdSchema,
		displayName: Type.Optional(NonEmptyString),
		version: NonEmptyString,
		platform: NonEmptyString,
		deviceFamily: Type.Optional(NonEmptyString),
		modelIdentifier: Type.Optional(NonEmptyString),
		mode: GatewayClientModeSchema,
		instanceId: Type.Optional(NonEmptyString)
	}, { additionalProperties: false }),
	caps: Type.Optional(Type.Array(NonEmptyString, { default: [] })),
	commands: Type.Optional(Type.Array(NonEmptyString)),
	permissions: Type.Optional(Type.Record(NonEmptyString, Type.Boolean())),
	pathEnv: Type.Optional(Type.String()),
	role: Type.Optional(NonEmptyString),
	scopes: Type.Optional(Type.Array(NonEmptyString)),
	device: Type.Optional(Type.Object({
		id: NonEmptyString,
		publicKey: NonEmptyString,
		signature: NonEmptyString,
		signedAt: Type.Integer({ minimum: 0 }),
		nonce: NonEmptyString
	}, { additionalProperties: false })),
	auth: Type.Optional(Type.Object({
		token: Type.Optional(Type.String()),
		deviceToken: Type.Optional(Type.String()),
		password: Type.Optional(Type.String())
	}, { additionalProperties: false })),
	locale: Type.Optional(Type.String()),
	userAgent: Type.Optional(Type.String())
}, { additionalProperties: false });
const HelloOkSchema = Type.Object({
	type: Type.Literal("hello-ok"),
	protocol: Type.Integer({ minimum: 1 }),
	server: Type.Object({
		version: NonEmptyString,
		connId: NonEmptyString
	}, { additionalProperties: false }),
	features: Type.Object({
		methods: Type.Array(NonEmptyString),
		events: Type.Array(NonEmptyString)
	}, { additionalProperties: false }),
	snapshot: SnapshotSchema,
	canvasHostUrl: Type.Optional(NonEmptyString),
	auth: Type.Optional(Type.Object({
		deviceToken: NonEmptyString,
		role: NonEmptyString,
		scopes: Type.Array(NonEmptyString),
		issuedAtMs: Type.Optional(Type.Integer({ minimum: 0 }))
	}, { additionalProperties: false })),
	policy: Type.Object({
		maxPayload: Type.Integer({ minimum: 1 }),
		maxBufferedBytes: Type.Integer({ minimum: 1 }),
		tickIntervalMs: Type.Integer({ minimum: 1 })
	}, { additionalProperties: false })
}, { additionalProperties: false });
const ErrorShapeSchema = Type.Object({
	code: NonEmptyString,
	message: NonEmptyString,
	details: Type.Optional(Type.Unknown()),
	retryable: Type.Optional(Type.Boolean()),
	retryAfterMs: Type.Optional(Type.Integer({ minimum: 0 }))
}, { additionalProperties: false });
const RequestFrameSchema = Type.Object({
	type: Type.Literal("req"),
	id: NonEmptyString,
	method: NonEmptyString,
	params: Type.Optional(Type.Unknown())
}, { additionalProperties: false });
const ResponseFrameSchema = Type.Object({
	type: Type.Literal("res"),
	id: NonEmptyString,
	ok: Type.Boolean(),
	payload: Type.Optional(Type.Unknown()),
	error: Type.Optional(ErrorShapeSchema)
}, { additionalProperties: false });
const EventFrameSchema = Type.Object({
	type: Type.Literal("event"),
	event: NonEmptyString,
	payload: Type.Optional(Type.Unknown()),
	seq: Type.Optional(Type.Integer({ minimum: 0 })),
	stateVersion: Type.Optional(StateVersionSchema)
}, { additionalProperties: false });
const GatewayFrameSchema = Type.Union([
	RequestFrameSchema,
	ResponseFrameSchema,
	EventFrameSchema
], { discriminator: "type" });

//#endregion
//#region src/gateway/protocol/schema/logs-chat.ts
const LogsTailParamsSchema = Type.Object({
	cursor: Type.Optional(Type.Integer({ minimum: 0 })),
	limit: Type.Optional(Type.Integer({
		minimum: 1,
		maximum: 5e3
	})),
	maxBytes: Type.Optional(Type.Integer({
		minimum: 1,
		maximum: 1e6
	}))
}, { additionalProperties: false });
const LogsTailResultSchema = Type.Object({
	file: NonEmptyString,
	cursor: Type.Integer({ minimum: 0 }),
	size: Type.Integer({ minimum: 0 }),
	lines: Type.Array(Type.String()),
	truncated: Type.Optional(Type.Boolean()),
	reset: Type.Optional(Type.Boolean())
}, { additionalProperties: false });
const ChatHistoryParamsSchema = Type.Object({
	sessionKey: NonEmptyString,
	limit: Type.Optional(Type.Integer({
		minimum: 1,
		maximum: 1e3
	}))
}, { additionalProperties: false });
const ChatSendParamsSchema = Type.Object({
	sessionKey: NonEmptyString,
	message: Type.String(),
	thinking: Type.Optional(Type.String()),
	deliver: Type.Optional(Type.Boolean()),
	attachments: Type.Optional(Type.Array(Type.Unknown())),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
	idempotencyKey: NonEmptyString
}, { additionalProperties: false });
const ChatAbortParamsSchema = Type.Object({
	sessionKey: NonEmptyString,
	runId: Type.Optional(NonEmptyString)
}, { additionalProperties: false });
const ChatInjectParamsSchema = Type.Object({
	sessionKey: NonEmptyString,
	message: NonEmptyString,
	label: Type.Optional(Type.String({ maxLength: 100 }))
}, { additionalProperties: false });
const ChatEventSchema = Type.Object({
	runId: NonEmptyString,
	sessionKey: NonEmptyString,
	seq: Type.Integer({ minimum: 0 }),
	state: Type.Union([
		Type.Literal("delta"),
		Type.Literal("final"),
		Type.Literal("aborted"),
		Type.Literal("error")
	]),
	message: Type.Optional(Type.Unknown()),
	errorMessage: Type.Optional(Type.String()),
	usage: Type.Optional(Type.Unknown()),
	stopReason: Type.Optional(Type.String())
}, { additionalProperties: false });

//#endregion
//#region src/gateway/protocol/schema/nodes.ts
const NodePairRequestParamsSchema = Type.Object({
	nodeId: NonEmptyString,
	displayName: Type.Optional(NonEmptyString),
	platform: Type.Optional(NonEmptyString),
	version: Type.Optional(NonEmptyString),
	coreVersion: Type.Optional(NonEmptyString),
	uiVersion: Type.Optional(NonEmptyString),
	deviceFamily: Type.Optional(NonEmptyString),
	modelIdentifier: Type.Optional(NonEmptyString),
	caps: Type.Optional(Type.Array(NonEmptyString)),
	commands: Type.Optional(Type.Array(NonEmptyString)),
	remoteIp: Type.Optional(NonEmptyString),
	silent: Type.Optional(Type.Boolean())
}, { additionalProperties: false });
const NodePairListParamsSchema = Type.Object({}, { additionalProperties: false });
const NodePairApproveParamsSchema = Type.Object({ requestId: NonEmptyString }, { additionalProperties: false });
const NodePairRejectParamsSchema = Type.Object({ requestId: NonEmptyString }, { additionalProperties: false });
const NodePairVerifyParamsSchema = Type.Object({
	nodeId: NonEmptyString,
	token: NonEmptyString
}, { additionalProperties: false });
const NodeRenameParamsSchema = Type.Object({
	nodeId: NonEmptyString,
	displayName: NonEmptyString
}, { additionalProperties: false });
const NodeListParamsSchema = Type.Object({}, { additionalProperties: false });
const NodeDescribeParamsSchema = Type.Object({ nodeId: NonEmptyString }, { additionalProperties: false });
const NodeInvokeParamsSchema = Type.Object({
	nodeId: NonEmptyString,
	command: NonEmptyString,
	params: Type.Optional(Type.Unknown()),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
	idempotencyKey: NonEmptyString
}, { additionalProperties: false });
const NodeInvokeResultParamsSchema = Type.Object({
	id: NonEmptyString,
	nodeId: NonEmptyString,
	ok: Type.Boolean(),
	payload: Type.Optional(Type.Unknown()),
	payloadJSON: Type.Optional(Type.String()),
	error: Type.Optional(Type.Object({
		code: Type.Optional(NonEmptyString),
		message: Type.Optional(NonEmptyString)
	}, { additionalProperties: false }))
}, { additionalProperties: false });
const NodeEventParamsSchema = Type.Object({
	event: NonEmptyString,
	payload: Type.Optional(Type.Unknown()),
	payloadJSON: Type.Optional(Type.String())
}, { additionalProperties: false });
const NodeInvokeRequestEventSchema = Type.Object({
	id: NonEmptyString,
	nodeId: NonEmptyString,
	command: NonEmptyString,
	paramsJSON: Type.Optional(Type.String()),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
	idempotencyKey: Type.Optional(NonEmptyString)
}, { additionalProperties: false });

//#endregion
//#region src/gateway/protocol/schema/push.ts
const ApnsEnvironmentSchema = Type.String({ enum: ["sandbox", "production"] });
const PushTestParamsSchema = Type.Object({
	nodeId: NonEmptyString,
	title: Type.Optional(Type.String()),
	body: Type.Optional(Type.String()),
	environment: Type.Optional(ApnsEnvironmentSchema)
}, { additionalProperties: false });
const PushTestResultSchema = Type.Object({
	ok: Type.Boolean(),
	status: Type.Integer(),
	apnsId: Type.Optional(Type.String()),
	reason: Type.Optional(Type.String()),
	tokenSuffix: Type.String(),
	topic: Type.String(),
	environment: ApnsEnvironmentSchema
}, { additionalProperties: false });

//#endregion
//#region src/gateway/protocol/schema/sessions.ts
const SessionsListParamsSchema = Type.Object({
	limit: Type.Optional(Type.Integer({ minimum: 1 })),
	activeMinutes: Type.Optional(Type.Integer({ minimum: 1 })),
	includeGlobal: Type.Optional(Type.Boolean()),
	includeUnknown: Type.Optional(Type.Boolean()),
	includeDerivedTitles: Type.Optional(Type.Boolean()),
	includeLastMessage: Type.Optional(Type.Boolean()),
	label: Type.Optional(SessionLabelString),
	spawnedBy: Type.Optional(NonEmptyString),
	agentId: Type.Optional(NonEmptyString),
	search: Type.Optional(Type.String())
}, { additionalProperties: false });
const SessionsPreviewParamsSchema = Type.Object({
	keys: Type.Array(NonEmptyString, { minItems: 1 }),
	limit: Type.Optional(Type.Integer({ minimum: 1 })),
	maxChars: Type.Optional(Type.Integer({ minimum: 20 }))
}, { additionalProperties: false });
const SessionsResolveParamsSchema = Type.Object({
	key: Type.Optional(NonEmptyString),
	sessionId: Type.Optional(NonEmptyString),
	label: Type.Optional(SessionLabelString),
	agentId: Type.Optional(NonEmptyString),
	spawnedBy: Type.Optional(NonEmptyString),
	includeGlobal: Type.Optional(Type.Boolean()),
	includeUnknown: Type.Optional(Type.Boolean())
}, { additionalProperties: false });
const SessionsPatchParamsSchema = Type.Object({
	key: NonEmptyString,
	label: Type.Optional(Type.Union([SessionLabelString, Type.Null()])),
	thinkingLevel: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
	verboseLevel: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
	reasoningLevel: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
	responseUsage: Type.Optional(Type.Union([
		Type.Literal("off"),
		Type.Literal("tokens"),
		Type.Literal("full"),
		Type.Literal("on"),
		Type.Null()
	])),
	elevatedLevel: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
	execHost: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
	execSecurity: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
	execAsk: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
	execNode: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
	model: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
	spawnedBy: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
	spawnDepth: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
	sendPolicy: Type.Optional(Type.Union([
		Type.Literal("allow"),
		Type.Literal("deny"),
		Type.Null()
	])),
	groupActivation: Type.Optional(Type.Union([
		Type.Literal("mention"),
		Type.Literal("always"),
		Type.Null()
	]))
}, { additionalProperties: false });
const SessionsResetParamsSchema = Type.Object({
	key: NonEmptyString,
	reason: Type.Optional(Type.Union([Type.Literal("new"), Type.Literal("reset")]))
}, { additionalProperties: false });
const SessionsDeleteParamsSchema = Type.Object({
	key: NonEmptyString,
	deleteTranscript: Type.Optional(Type.Boolean()),
	emitLifecycleHooks: Type.Optional(Type.Boolean())
}, { additionalProperties: false });
const SessionsCompactParamsSchema = Type.Object({
	key: NonEmptyString,
	maxLines: Type.Optional(Type.Integer({ minimum: 1 }))
}, { additionalProperties: false });
const SessionsUsageParamsSchema = Type.Object({
	key: Type.Optional(NonEmptyString),
	startDate: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })),
	endDate: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })),
	mode: Type.Optional(Type.Union([
		Type.Literal("utc"),
		Type.Literal("gateway"),
		Type.Literal("specific")
	])),
	utcOffset: Type.Optional(Type.String({ pattern: "^UTC[+-]\\d{1,2}(?::[0-5]\\d)?$" })),
	limit: Type.Optional(Type.Integer({ minimum: 1 })),
	includeContextWeight: Type.Optional(Type.Boolean())
}, { additionalProperties: false });

//#endregion
//#region src/gateway/protocol/schema/wizard.ts
const WizardRunStatusSchema = Type.Union([
	Type.Literal("running"),
	Type.Literal("done"),
	Type.Literal("cancelled"),
	Type.Literal("error")
]);
const WizardStartParamsSchema = Type.Object({
	mode: Type.Optional(Type.Union([Type.Literal("local"), Type.Literal("remote")])),
	workspace: Type.Optional(Type.String())
}, { additionalProperties: false });
const WizardAnswerSchema = Type.Object({
	stepId: NonEmptyString,
	value: Type.Optional(Type.Unknown())
}, { additionalProperties: false });
const WizardNextParamsSchema = Type.Object({
	sessionId: NonEmptyString,
	answer: Type.Optional(WizardAnswerSchema)
}, { additionalProperties: false });
const WizardSessionIdParamsSchema = Type.Object({ sessionId: NonEmptyString }, { additionalProperties: false });
const WizardCancelParamsSchema = WizardSessionIdParamsSchema;
const WizardStatusParamsSchema = WizardSessionIdParamsSchema;
const WizardStepOptionSchema = Type.Object({
	value: Type.Unknown(),
	label: NonEmptyString,
	hint: Type.Optional(Type.String())
}, { additionalProperties: false });
const WizardStepSchema = Type.Object({
	id: NonEmptyString,
	type: Type.Union([
		Type.Literal("note"),
		Type.Literal("select"),
		Type.Literal("text"),
		Type.Literal("confirm"),
		Type.Literal("multiselect"),
		Type.Literal("progress"),
		Type.Literal("action")
	]),
	title: Type.Optional(Type.String()),
	message: Type.Optional(Type.String()),
	options: Type.Optional(Type.Array(WizardStepOptionSchema)),
	initialValue: Type.Optional(Type.Unknown()),
	placeholder: Type.Optional(Type.String()),
	sensitive: Type.Optional(Type.Boolean()),
	executor: Type.Optional(Type.Union([Type.Literal("gateway"), Type.Literal("client")]))
}, { additionalProperties: false });
const WizardResultFields = {
	done: Type.Boolean(),
	step: Type.Optional(WizardStepSchema),
	status: Type.Optional(WizardRunStatusSchema),
	error: Type.Optional(Type.String())
};
const WizardNextResultSchema = Type.Object(WizardResultFields, { additionalProperties: false });
const WizardStartResultSchema = Type.Object({
	sessionId: NonEmptyString,
	...WizardResultFields
}, { additionalProperties: false });
const WizardStatusResultSchema = Type.Object({
	status: WizardRunStatusSchema,
	error: Type.Optional(Type.String())
}, { additionalProperties: false });

//#endregion
//#region src/gateway/protocol/schema/protocol-schemas.ts
const PROTOCOL_VERSION = 3;

//#endregion
//#region src/gateway/protocol/index.ts
const ajv = new AjvPkg({
	allErrors: true,
	strict: false,
	removeAdditional: false
});
const validateConnectParams = ajv.compile(ConnectParamsSchema);
const validateRequestFrame = ajv.compile(RequestFrameSchema);
const validateResponseFrame = ajv.compile(ResponseFrameSchema);
const validateEventFrame = ajv.compile(EventFrameSchema);
const validateSendParams = ajv.compile(SendParamsSchema);
const validatePollParams = ajv.compile(PollParamsSchema);
const validateAgentParams = ajv.compile(AgentParamsSchema);
const validateAgentIdentityParams = ajv.compile(AgentIdentityParamsSchema);
const validateAgentWaitParams = ajv.compile(AgentWaitParamsSchema);
const validateWakeParams = ajv.compile(WakeParamsSchema);
const validateAgentsListParams = ajv.compile(AgentsListParamsSchema);
const validateAgentsCreateParams = ajv.compile(AgentsCreateParamsSchema);
const validateAgentsUpdateParams = ajv.compile(AgentsUpdateParamsSchema);
const validateAgentsDeleteParams = ajv.compile(AgentsDeleteParamsSchema);
const validateAgentsFilesListParams = ajv.compile(AgentsFilesListParamsSchema);
const validateAgentsFilesGetParams = ajv.compile(AgentsFilesGetParamsSchema);
const validateAgentsFilesSetParams = ajv.compile(AgentsFilesSetParamsSchema);
const validateNodePairRequestParams = ajv.compile(NodePairRequestParamsSchema);
const validateNodePairListParams = ajv.compile(NodePairListParamsSchema);
const validateNodePairApproveParams = ajv.compile(NodePairApproveParamsSchema);
const validateNodePairRejectParams = ajv.compile(NodePairRejectParamsSchema);
const validateNodePairVerifyParams = ajv.compile(NodePairVerifyParamsSchema);
const validateNodeRenameParams = ajv.compile(NodeRenameParamsSchema);
const validateNodeListParams = ajv.compile(NodeListParamsSchema);
const validateNodeDescribeParams = ajv.compile(NodeDescribeParamsSchema);
const validateNodeInvokeParams = ajv.compile(NodeInvokeParamsSchema);
const validateNodeInvokeResultParams = ajv.compile(NodeInvokeResultParamsSchema);
const validateNodeEventParams = ajv.compile(NodeEventParamsSchema);
const validatePushTestParams = ajv.compile(PushTestParamsSchema);
const validateSessionsListParams = ajv.compile(SessionsListParamsSchema);
const validateSessionsPreviewParams = ajv.compile(SessionsPreviewParamsSchema);
const validateSessionsResolveParams = ajv.compile(SessionsResolveParamsSchema);
const validateSessionsPatchParams = ajv.compile(SessionsPatchParamsSchema);
const validateSessionsResetParams = ajv.compile(SessionsResetParamsSchema);
const validateSessionsDeleteParams = ajv.compile(SessionsDeleteParamsSchema);
const validateSessionsCompactParams = ajv.compile(SessionsCompactParamsSchema);
const validateSessionsUsageParams = ajv.compile(SessionsUsageParamsSchema);
const validateConfigGetParams = ajv.compile(ConfigGetParamsSchema);
const validateConfigSetParams = ajv.compile(ConfigSetParamsSchema);
const validateConfigApplyParams = ajv.compile(ConfigApplyParamsSchema);
const validateConfigPatchParams = ajv.compile(ConfigPatchParamsSchema);
const validateConfigSchemaParams = ajv.compile(ConfigSchemaParamsSchema);
const validateWizardStartParams = ajv.compile(WizardStartParamsSchema);
const validateWizardNextParams = ajv.compile(WizardNextParamsSchema);
const validateWizardCancelParams = ajv.compile(WizardCancelParamsSchema);
const validateWizardStatusParams = ajv.compile(WizardStatusParamsSchema);
const validateTalkModeParams = ajv.compile(TalkModeParamsSchema);
const validateTalkConfigParams = ajv.compile(TalkConfigParamsSchema);
const validateChannelsStatusParams = ajv.compile(ChannelsStatusParamsSchema);
const validateChannelsLogoutParams = ajv.compile(ChannelsLogoutParamsSchema);
const validateModelsListParams = ajv.compile(ModelsListParamsSchema);
const validateSkillsStatusParams = ajv.compile(SkillsStatusParamsSchema);
const validateToolsCatalogParams = ajv.compile(ToolsCatalogParamsSchema);
const validateSkillsBinsParams = ajv.compile(SkillsBinsParamsSchema);
const validateSkillsInstallParams = ajv.compile(SkillsInstallParamsSchema);
const validateSkillsUpdateParams = ajv.compile(SkillsUpdateParamsSchema);
const validateCronListParams = ajv.compile(CronListParamsSchema);
const validateCronStatusParams = ajv.compile(CronStatusParamsSchema);
const validateCronAddParams = ajv.compile(CronAddParamsSchema);
const validateCronUpdateParams = ajv.compile(CronUpdateParamsSchema);
const validateCronRemoveParams = ajv.compile(CronRemoveParamsSchema);
const validateCronRunParams = ajv.compile(CronRunParamsSchema);
const validateCronRunsParams = ajv.compile(CronRunsParamsSchema);
const validateDevicePairListParams = ajv.compile(DevicePairListParamsSchema);
const validateDevicePairApproveParams = ajv.compile(DevicePairApproveParamsSchema);
const validateDevicePairRejectParams = ajv.compile(DevicePairRejectParamsSchema);
const validateDevicePairRemoveParams = ajv.compile(DevicePairRemoveParamsSchema);
const validateDeviceTokenRotateParams = ajv.compile(DeviceTokenRotateParamsSchema);
const validateDeviceTokenRevokeParams = ajv.compile(DeviceTokenRevokeParamsSchema);
const validateExecApprovalsGetParams = ajv.compile(ExecApprovalsGetParamsSchema);
const validateExecApprovalsSetParams = ajv.compile(ExecApprovalsSetParamsSchema);
const validateExecApprovalRequestParams = ajv.compile(ExecApprovalRequestParamsSchema);
const validateExecApprovalResolveParams = ajv.compile(ExecApprovalResolveParamsSchema);
const validateExecApprovalsNodeGetParams = ajv.compile(ExecApprovalsNodeGetParamsSchema);
const validateExecApprovalsNodeSetParams = ajv.compile(ExecApprovalsNodeSetParamsSchema);
const validateLogsTailParams = ajv.compile(LogsTailParamsSchema);
const validateChatHistoryParams = ajv.compile(ChatHistoryParamsSchema);
const validateChatSendParams = ajv.compile(ChatSendParamsSchema);
const validateChatAbortParams = ajv.compile(ChatAbortParamsSchema);
const validateChatInjectParams = ajv.compile(ChatInjectParamsSchema);
const validateChatEvent = ajv.compile(ChatEventSchema);
const validateUpdateRunParams = ajv.compile(UpdateRunParamsSchema);
const validateWebLoginStartParams = ajv.compile(WebLoginStartParamsSchema);
const validateWebLoginWaitParams = ajv.compile(WebLoginWaitParamsSchema);
function formatValidationErrors(errors) {
	if (!errors?.length) return "unknown validation error";
	const parts = [];
	for (const err of errors) {
		const keyword = typeof err?.keyword === "string" ? err.keyword : "";
		const instancePath = typeof err?.instancePath === "string" ? err.instancePath : "";
		if (keyword === "additionalProperties") {
			const additionalProperty = (err?.params)?.additionalProperty;
			if (typeof additionalProperty === "string" && additionalProperty.trim()) {
				const where = instancePath ? `at ${instancePath}` : "at root";
				parts.push(`${where}: unexpected property '${additionalProperty}'`);
				continue;
			}
		}
		const message = typeof err?.message === "string" && err.message.trim() ? err.message : "validation error";
		const where = instancePath ? `at ${instancePath}: ` : "";
		parts.push(`${where}${message}`);
	}
	const unique = Array.from(new Set(parts.filter((part) => part.trim())));
	if (!unique.length) return ajv.errorsText(errors, { separator: "; " }) || "unknown validation error";
	return unique.join("; ");
}

//#endregion
//#region src/gateway/client.ts
var GatewayClient = class {
	constructor(opts) {
		this.ws = null;
		this.pending = /* @__PURE__ */ new Map();
		this.backoffMs = 1e3;
		this.closed = false;
		this.lastSeq = null;
		this.connectNonce = null;
		this.connectSent = false;
		this.connectTimer = null;
		this.lastTick = null;
		this.tickIntervalMs = 3e4;
		this.tickTimer = null;
		this.opts = {
			...opts,
			deviceIdentity: opts.deviceIdentity ?? loadOrCreateDeviceIdentity()
		};
	}
	start() {
		if (this.closed) return;
		const url = this.opts.url ?? "ws://127.0.0.1:18789";
		if (this.opts.tlsFingerprint && !url.startsWith("wss://")) {
			this.opts.onConnectError?.(/* @__PURE__ */ new Error("gateway tls fingerprint requires wss:// gateway url"));
			return;
		}
		if (!isSecureWebSocketUrl(url)) {
			let displayHost = url;
			try {
				displayHost = new URL(url).hostname || url;
			} catch {}
			const error = /* @__PURE__ */ new Error(`SECURITY ERROR: Cannot connect to "${displayHost}" over plaintext ws://. Both credentials and chat data would be exposed to network interception. Use wss:// for remote URLs. Safe defaults: keep gateway.bind=loopback and connect via SSH tunnel (ssh -N -L 18789:127.0.0.1:18789 user@gateway-host), or use Tailscale Serve/Funnel. Run \`openclaw doctor --fix\` for guidance.`);
			this.opts.onConnectError?.(error);
			return;
		}
		const wsOptions = { maxPayload: 25 * 1024 * 1024 };
		if (url.startsWith("wss://") && this.opts.tlsFingerprint) {
			wsOptions.rejectUnauthorized = false;
			wsOptions.checkServerIdentity = ((_host, cert) => {
				const fingerprintValue = typeof cert === "object" && cert && "fingerprint256" in cert ? cert.fingerprint256 ?? "" : "";
				const fingerprint = normalizeFingerprint(typeof fingerprintValue === "string" ? fingerprintValue : "");
				const expected = normalizeFingerprint(this.opts.tlsFingerprint ?? "");
				if (!expected) return /* @__PURE__ */ new Error("gateway tls fingerprint missing");
				if (!fingerprint) return /* @__PURE__ */ new Error("gateway tls fingerprint unavailable");
				if (fingerprint !== expected) return /* @__PURE__ */ new Error("gateway tls fingerprint mismatch");
			});
		}
		this.ws = new WebSocket$1(url, wsOptions);
		this.ws.on("open", () => {
			if (url.startsWith("wss://") && this.opts.tlsFingerprint) {
				const tlsError = this.validateTlsFingerprint();
				if (tlsError) {
					this.opts.onConnectError?.(tlsError);
					this.ws?.close(1008, tlsError.message);
					return;
				}
			}
			this.queueConnect();
		});
		this.ws.on("message", (data) => this.handleMessage(rawDataToString(data)));
		this.ws.on("close", (code, reason) => {
			const reasonText = rawDataToString(reason);
			this.ws = null;
			if (code === 1008 && reasonText.toLowerCase().includes("device token mismatch") && !this.opts.token && !this.opts.password && this.opts.deviceIdentity) {
				const deviceId = this.opts.deviceIdentity.deviceId;
				const role = this.opts.role ?? "operator";
				try {
					clearDeviceAuthToken({
						deviceId,
						role
					});
					clearDevicePairing(deviceId).catch((err) => {
						logDebug(`failed clearing stale device pairing for device ${deviceId}: ${String(err)}`);
					});
					logDebug(`cleared stale device-auth token for device ${deviceId}`);
				} catch (err) {
					logDebug(`failed clearing stale device-auth token for device ${deviceId}: ${String(err)}`);
				}
			}
			this.flushPendingErrors(/* @__PURE__ */ new Error(`gateway closed (${code}): ${reasonText}`));
			this.scheduleReconnect();
			this.opts.onClose?.(code, reasonText);
		});
		this.ws.on("error", (err) => {
			logDebug(`gateway client error: ${String(err)}`);
			if (!this.connectSent) this.opts.onConnectError?.(err instanceof Error ? err : new Error(String(err)));
		});
	}
	stop() {
		this.closed = true;
		if (this.tickTimer) {
			clearInterval(this.tickTimer);
			this.tickTimer = null;
		}
		this.ws?.close();
		this.ws = null;
		this.flushPendingErrors(/* @__PURE__ */ new Error("gateway client stopped"));
	}
	sendConnect() {
		if (this.connectSent) return;
		const nonce = this.connectNonce?.trim() ?? "";
		if (!nonce) {
			this.opts.onConnectError?.(/* @__PURE__ */ new Error("gateway connect challenge missing nonce"));
			this.ws?.close(1008, "connect challenge missing nonce");
			return;
		}
		this.connectSent = true;
		if (this.connectTimer) {
			clearTimeout(this.connectTimer);
			this.connectTimer = null;
		}
		const role = this.opts.role ?? "operator";
		const explicitGatewayToken = this.opts.token?.trim() || void 0;
		const explicitDeviceToken = this.opts.deviceToken?.trim() || void 0;
		const storedToken = this.opts.deviceIdentity ? loadDeviceAuthToken({
			deviceId: this.opts.deviceIdentity.deviceId,
			role
		})?.token : null;
		const resolvedDeviceToken = explicitDeviceToken ?? (!explicitGatewayToken ? storedToken ?? void 0 : void 0);
		const authToken = explicitGatewayToken ?? resolvedDeviceToken;
		const authPassword = this.opts.password?.trim() || void 0;
		const auth = authToken || authPassword || resolvedDeviceToken ? {
			token: authToken,
			deviceToken: resolvedDeviceToken,
			password: authPassword
		} : void 0;
		const signedAtMs = Date.now();
		const scopes = this.opts.scopes ?? ["operator.admin"];
		const platform = this.opts.platform ?? process.platform;
		const device = (() => {
			if (!this.opts.deviceIdentity) return;
			const payload = buildDeviceAuthPayloadV3({
				deviceId: this.opts.deviceIdentity.deviceId,
				clientId: this.opts.clientName ?? GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
				clientMode: this.opts.mode ?? GATEWAY_CLIENT_MODES.BACKEND,
				role,
				scopes,
				signedAtMs,
				token: authToken ?? null,
				nonce,
				platform,
				deviceFamily: this.opts.deviceFamily
			});
			const signature = signDevicePayload(this.opts.deviceIdentity.privateKeyPem, payload);
			return {
				id: this.opts.deviceIdentity.deviceId,
				publicKey: publicKeyRawBase64UrlFromPem(this.opts.deviceIdentity.publicKeyPem),
				signature,
				signedAt: signedAtMs,
				nonce
			};
		})();
		const params = {
			minProtocol: this.opts.minProtocol ?? PROTOCOL_VERSION,
			maxProtocol: this.opts.maxProtocol ?? PROTOCOL_VERSION,
			client: {
				id: this.opts.clientName ?? GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
				displayName: this.opts.clientDisplayName,
				version: this.opts.clientVersion ?? "dev",
				platform,
				deviceFamily: this.opts.deviceFamily,
				mode: this.opts.mode ?? GATEWAY_CLIENT_MODES.BACKEND,
				instanceId: this.opts.instanceId
			},
			caps: Array.isArray(this.opts.caps) ? this.opts.caps : [],
			commands: Array.isArray(this.opts.commands) ? this.opts.commands : void 0,
			permissions: this.opts.permissions && typeof this.opts.permissions === "object" ? this.opts.permissions : void 0,
			pathEnv: this.opts.pathEnv,
			auth,
			role,
			scopes,
			device
		};
		this.request("connect", params).then((helloOk) => {
			const authInfo = helloOk?.auth;
			if (authInfo?.deviceToken && this.opts.deviceIdentity) storeDeviceAuthToken({
				deviceId: this.opts.deviceIdentity.deviceId,
				role: authInfo.role ?? role,
				token: authInfo.deviceToken,
				scopes: authInfo.scopes ?? []
			});
			this.backoffMs = 1e3;
			this.tickIntervalMs = typeof helloOk.policy?.tickIntervalMs === "number" ? helloOk.policy.tickIntervalMs : 3e4;
			this.lastTick = Date.now();
			this.startTickWatch();
			this.opts.onHelloOk?.(helloOk);
		}).catch((err) => {
			this.opts.onConnectError?.(err instanceof Error ? err : new Error(String(err)));
			const msg = `gateway connect failed: ${String(err)}`;
			if (this.opts.mode === GATEWAY_CLIENT_MODES.PROBE) logDebug(msg);
			else logError(msg);
			this.ws?.close(1008, "connect failed");
		});
	}
	handleMessage(raw) {
		try {
			const parsed = JSON.parse(raw);
			if (validateEventFrame(parsed)) {
				const evt = parsed;
				if (evt.event === "connect.challenge") {
					const payload = evt.payload;
					const nonce = payload && typeof payload.nonce === "string" ? payload.nonce : null;
					if (!nonce || nonce.trim().length === 0) {
						this.opts.onConnectError?.(/* @__PURE__ */ new Error("gateway connect challenge missing nonce"));
						this.ws?.close(1008, "connect challenge missing nonce");
						return;
					}
					this.connectNonce = nonce.trim();
					this.sendConnect();
					return;
				}
				const seq = typeof evt.seq === "number" ? evt.seq : null;
				if (seq !== null) {
					if (this.lastSeq !== null && seq > this.lastSeq + 1) this.opts.onGap?.({
						expected: this.lastSeq + 1,
						received: seq
					});
					this.lastSeq = seq;
				}
				if (evt.event === "tick") this.lastTick = Date.now();
				this.opts.onEvent?.(evt);
				return;
			}
			if (validateResponseFrame(parsed)) {
				const pending = this.pending.get(parsed.id);
				if (!pending) return;
				const status = parsed.payload?.status;
				if (pending.expectFinal && status === "accepted") return;
				this.pending.delete(parsed.id);
				if (parsed.ok) pending.resolve(parsed.payload);
				else pending.reject(new Error(parsed.error?.message ?? "unknown error"));
			}
		} catch (err) {
			logDebug(`gateway client parse error: ${String(err)}`);
		}
	}
	queueConnect() {
		this.connectNonce = null;
		this.connectSent = false;
		const rawConnectDelayMs = this.opts.connectDelayMs;
		const connectChallengeTimeoutMs = typeof rawConnectDelayMs === "number" && Number.isFinite(rawConnectDelayMs) ? Math.max(250, Math.min(1e4, rawConnectDelayMs)) : 2e3;
		if (this.connectTimer) clearTimeout(this.connectTimer);
		this.connectTimer = setTimeout(() => {
			if (this.connectSent || this.ws?.readyState !== WebSocket$1.OPEN) return;
			this.opts.onConnectError?.(/* @__PURE__ */ new Error("gateway connect challenge timeout"));
			this.ws?.close(1008, "connect challenge timeout");
		}, connectChallengeTimeoutMs);
	}
	scheduleReconnect() {
		if (this.closed) return;
		if (this.tickTimer) {
			clearInterval(this.tickTimer);
			this.tickTimer = null;
		}
		const delay = this.backoffMs;
		this.backoffMs = Math.min(this.backoffMs * 2, 3e4);
		setTimeout(() => this.start(), delay).unref();
	}
	flushPendingErrors(err) {
		for (const [, p] of this.pending) p.reject(err);
		this.pending.clear();
	}
	startTickWatch() {
		if (this.tickTimer) clearInterval(this.tickTimer);
		const rawMinInterval = this.opts.tickWatchMinIntervalMs;
		const minInterval = typeof rawMinInterval === "number" && Number.isFinite(rawMinInterval) ? Math.max(1, Math.min(3e4, rawMinInterval)) : 1e3;
		const interval = Math.max(this.tickIntervalMs, minInterval);
		this.tickTimer = setInterval(() => {
			if (this.closed) return;
			if (!this.lastTick) return;
			if (Date.now() - this.lastTick > this.tickIntervalMs * 2) this.ws?.close(4e3, "tick timeout");
		}, interval);
	}
	validateTlsFingerprint() {
		if (!this.opts.tlsFingerprint || !this.ws) return null;
		const expected = normalizeFingerprint(this.opts.tlsFingerprint);
		if (!expected) return /* @__PURE__ */ new Error("gateway tls fingerprint missing");
		const socket = this.ws._socket;
		if (!socket || typeof socket.getPeerCertificate !== "function") return /* @__PURE__ */ new Error("gateway tls fingerprint unavailable");
		const fingerprint = normalizeFingerprint(socket.getPeerCertificate()?.fingerprint256 ?? "");
		if (!fingerprint) return /* @__PURE__ */ new Error("gateway tls fingerprint unavailable");
		if (fingerprint !== expected) return /* @__PURE__ */ new Error("gateway tls fingerprint mismatch");
		return null;
	}
	async request(method, params, opts) {
		if (!this.ws || this.ws.readyState !== WebSocket$1.OPEN) throw new Error("gateway not connected");
		const id = randomUUID();
		const frame = {
			type: "req",
			id,
			method,
			params
		};
		if (!validateRequestFrame(frame)) throw new Error(`invalid request frame: ${JSON.stringify(validateRequestFrame.errors, null, 2)}`);
		const expectFinal = opts?.expectFinal === true;
		const p = new Promise((resolve, reject) => {
			this.pending.set(id, {
				resolve: (value) => resolve(value),
				reject,
				expectFinal
			});
		});
		this.ws.send(JSON.stringify(frame));
		return p;
	}
};

//#endregion
export { validateNodePairRejectParams as $, loadOrCreateDeviceIdentity as $t, validateCronStatusParams as A, PROTOCOL_VERSION as At, validateExecApprovalsGetParams as B, getPairedDevice as Bt, validateConfigSetParams as C, validateWakeParams as Ct, validateCronRemoveParams as D, validateWizardNextParams as Dt, validateCronListParams as E, validateWizardCancelParams as Et, validateDevicePairRemoveParams as F, buildDeviceAuthPayload as Ft, validateModelsListParams as G, revokeDeviceToken as Gt, validateExecApprovalsNodeSetParams as H, rejectDevicePairing as Ht, validateDeviceTokenRevokeParams as I, buildDeviceAuthPayloadV3 as It, validateNodeInvokeParams as J, updatePairedDeviceMetadata as Jt, validateNodeDescribeParams as K, rotateDeviceToken as Kt, validateDeviceTokenRotateParams as L, normalizeDeviceMetadataForAuth as Lt, validateDevicePairApproveParams as M, errorShape as Mt, validateDevicePairListParams as N, SESSION_LABEL_MAX_LENGTH as Nt, validateCronRunParams as O, validateWizardStartParams as Ot, validateDevicePairRejectParams as P, parseSessionLabel as Pt, validateNodePairListParams as Q, deriveDeviceIdFromPublicKey as Qt, validateExecApprovalRequestParams as R, approveDevicePairing as Rt, validateConfigSchemaParams as S, validateUpdateRunParams as St, validateCronAddParams as T, validateWebLoginWaitParams as Tt, validateExecApprovalsSetParams as U, removePairedDevice as Ut, validateExecApprovalsNodeGetParams as V, listDevicePairing as Vt, validateLogsTailParams as W, requestDevicePairing as Wt, validateNodeListParams as X, roleScopesAllow as Xt, validateNodeInvokeResultParams as Y, verifyDeviceToken as Yt, validateNodePairApproveParams as Z, normalizeFingerprint as Zt, validateChatInjectParams as _, validateSkillsStatusParams as _t, validateAgentWaitParams as a, validateRequestFrame as at, validateConfigGetParams as b, validateTalkModeParams as bt, validateAgentsFilesGetParams as c, validateSessionsDeleteParams as ct, validateAgentsListParams as d, validateSessionsPreviewParams as dt, normalizeDevicePublicKeyBase64Url as en, validateNodePairRequestParams as et, validateAgentsUpdateParams as f, validateSessionsResetParams as ft, validateChatHistoryParams as g, validateSkillsInstallParams as gt, validateChatAbortParams as h, validateSkillsBinsParams as ht, validateAgentParams as i, validatePushTestParams as it, validateCronUpdateParams as j, ErrorCodes as jt, validateCronRunsParams as k, validateWizardStatusParams as kt, validateAgentsFilesListParams as l, validateSessionsListParams as lt, validateChannelsStatusParams as m, validateSessionsUsageParams as mt, formatValidationErrors as n, validateNodeRenameParams as nt, validateAgentsCreateParams as o, validateSendParams as ot, validateChannelsLogoutParams as p, validateSessionsResolveParams as pt, validateNodeEventParams as q, summarizeDeviceTokens as qt, validateAgentIdentityParams as r, validatePollParams as rt, validateAgentsDeleteParams as s, validateSessionsCompactParams as st, GatewayClient as t, verifyDeviceSignature as tn, validateNodePairVerifyParams as tt, validateAgentsFilesSetParams as u, validateSessionsPatchParams as ut, validateChatSendParams as v, validateSkillsUpdateParams as vt, validateConnectParams as w, validateWebLoginStartParams as wt, validateConfigPatchParams as x, validateToolsCatalogParams as xt, validateConfigApplyParams as y, validateTalkConfigParams as yt, validateExecApprovalResolveParams as z, ensureDeviceToken as zt };