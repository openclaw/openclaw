import { y as resolveStateDir } from "./paths-Cw7f9XhU.js";
import { n as privateFileStoreSync } from "./private-file-store-DMtyjgoc.js";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
//#region src/infra/device-identity.ts
function resolveDefaultIdentityPath() {
	return path.join(resolveStateDir(), "identity", "device.json");
}
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const ED25519_PKCS8_PRIVATE_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
function base64UrlEncode(buf) {
	return buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}
function base64UrlDecode(input) {
	const normalized = input.replaceAll("-", "+").replaceAll("_", "/");
	const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
	return Buffer.from(padded, "base64");
}
function pemEncode(label, der) {
	return `-----BEGIN ${label}-----\n${der.toString("base64").match(/.{1,64}/g)?.join("\n") ?? ""}\n-----END ${label}-----\n`;
}
function publicKeyPemFromRaw(publicKeyRaw) {
	return pemEncode("PUBLIC KEY", Buffer.concat([ED25519_SPKI_PREFIX, publicKeyRaw]));
}
function privateKeyPemFromRaw(privateKeyRaw) {
	return pemEncode("PRIVATE KEY", Buffer.concat([ED25519_PKCS8_PRIVATE_PREFIX, privateKeyRaw]));
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
function tryFingerprintPublicKey(publicKeyPem) {
	try {
		return fingerprintPublicKey(publicKeyPem);
	} catch {
		return null;
	}
}
function keyPairMatches(publicKeyPem, privateKeyPem) {
	try {
		const payload = Buffer.from("openclaw-device-identity-self-check", "utf8");
		const signature = crypto.sign(null, payload, crypto.createPrivateKey(privateKeyPem));
		return crypto.verify(null, payload, crypto.createPublicKey(publicKeyPem), signature);
	} catch {
		return false;
	}
}
function generateIdentity() {
	const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
	const publicKeyPem = publicKey.export({
		type: "spki",
		format: "pem"
	});
	const privateKeyPem = privateKey.export({
		type: "pkcs8",
		format: "pem"
	});
	return {
		deviceId: fingerprintPublicKey(publicKeyPem),
		publicKeyPem,
		privateKeyPem
	};
}
function isRecord(value) {
	return !!value && typeof value === "object";
}
function hasRecognizedIdentityShape(parsed) {
	return isRecord(parsed) && ("publicKeyPem" in parsed || "privateKeyPem" in parsed || "publicKey" in parsed || "privateKey" in parsed);
}
function normalizeStoredIdentity(parsed) {
	if (isRecord(parsed) && "version" in parsed && parsed.version === 1 && "deviceId" in parsed && typeof parsed.deviceId === "string" && "publicKeyPem" in parsed && typeof parsed.publicKeyPem === "string" && "privateKeyPem" in parsed && typeof parsed.privateKeyPem === "string") {
		const stored = parsed;
		const derivedId = tryFingerprintPublicKey(stored.publicKeyPem);
		if (!derivedId || !keyPairMatches(stored.publicKeyPem, stored.privateKeyPem)) return { kind: "recognized-invalid" };
		const identity = {
			deviceId: derivedId,
			publicKeyPem: stored.publicKeyPem,
			privateKeyPem: stored.privateKeyPem
		};
		return derivedId === stored.deviceId ? {
			kind: "identity",
			identity,
			validForReadOnly: true
		} : {
			kind: "identity",
			identity,
			validForReadOnly: false,
			stored: {
				...stored,
				deviceId: derivedId
			}
		};
	}
	if (isRecord(parsed) && !("version" in parsed) && "deviceId" in parsed && typeof parsed.deviceId === "string" && "publicKey" in parsed && typeof parsed.publicKey === "string" && "privateKey" in parsed && typeof parsed.privateKey === "string") {
		const stored = parsed;
		const publicKeyRaw = base64UrlDecode(stored.publicKey);
		const privateKeyRaw = base64UrlDecode(stored.privateKey);
		if (publicKeyRaw.length !== 32 || privateKeyRaw.length !== 32) return { kind: "recognized-invalid" };
		const publicKeyPem = publicKeyPemFromRaw(publicKeyRaw);
		const privateKeyPem = privateKeyPemFromRaw(privateKeyRaw);
		if (!keyPairMatches(publicKeyPem, privateKeyPem)) return { kind: "recognized-invalid" };
		const derivedId = fingerprintPublicKey(publicKeyPem);
		const validForReadOnly = derivedId === stored.deviceId;
		const migrated = {
			version: 1,
			deviceId: derivedId,
			publicKeyPem,
			privateKeyPem,
			createdAtMs: typeof stored.createdAtMs === "number" && Number.isFinite(stored.createdAtMs) ? stored.createdAtMs : Date.now()
		};
		return {
			kind: "identity",
			identity: {
				deviceId: derivedId,
				publicKeyPem,
				privateKeyPem
			},
			validForReadOnly,
			stored: migrated
		};
	}
	return hasRecognizedIdentityShape(parsed) ? { kind: "recognized-invalid" } : null;
}
function identityFileExists(filePath) {
	try {
		return fs.statSync(filePath).isFile();
	} catch {
		return false;
	}
}
function loadOrCreateDeviceIdentity(filePath = resolveDefaultIdentityPath()) {
	try {
		const store = privateFileStoreSync(path.dirname(filePath));
		const normalized = normalizeStoredIdentity(store.readJsonIfExists(path.basename(filePath)));
		if (normalized?.kind === "identity") {
			if (normalized.stored) try {
				store.writeJson(path.basename(filePath), normalized.stored, { trailingNewline: true });
			} catch {}
			return normalized.identity;
		}
		if (normalized?.kind === "recognized-invalid") return generateIdentity();
	} catch {
		if (identityFileExists(filePath)) return generateIdentity();
	}
	const identity = generateIdentity();
	const stored = {
		version: 1,
		deviceId: identity.deviceId,
		publicKeyPem: identity.publicKeyPem,
		privateKeyPem: identity.privateKeyPem,
		createdAtMs: Date.now()
	};
	privateFileStoreSync(path.dirname(filePath)).writeJson(path.basename(filePath), stored, { trailingNewline: true });
	return identity;
}
function loadDeviceIdentityIfPresent(filePath = resolveDefaultIdentityPath()) {
	try {
		const normalized = normalizeStoredIdentity(privateFileStoreSync(path.dirname(filePath)).readJsonIfExists(path.basename(filePath)));
		if (normalized?.kind !== "identity" || !normalized.validForReadOnly) return null;
		return normalized.identity;
	} catch {
		return null;
	}
}
function signDevicePayload(privateKeyPem, payload) {
	const key = crypto.createPrivateKey(privateKeyPem);
	return base64UrlEncode(crypto.sign(null, Buffer.from(payload, "utf8"), key));
}
function normalizeDevicePublicKeyBase64Url(publicKey) {
	try {
		if (publicKey.includes("BEGIN")) return base64UrlEncode(derivePublicKeyRaw(publicKey));
		const raw = base64UrlDecode(publicKey);
		if (raw.length === 0) return null;
		return base64UrlEncode(raw);
	} catch {
		return null;
	}
}
function deriveDeviceIdFromPublicKey(publicKey) {
	try {
		const raw = publicKey.includes("BEGIN") ? derivePublicKeyRaw(publicKey) : base64UrlDecode(publicKey);
		if (raw.length === 0) return null;
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
export { publicKeyRawBase64UrlFromPem as a, normalizeDevicePublicKeyBase64Url as i, loadDeviceIdentityIfPresent as n, signDevicePayload as o, loadOrCreateDeviceIdentity as r, verifyDeviceSignature as s, deriveDeviceIdFromPublicKey as t };
