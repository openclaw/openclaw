import { v as resolveStateDir } from "./paths-C1_Y0cDn.js";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
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
function loadDeviceIdentityIfPresent(filePath = resolveDefaultIdentityPath()) {
	try {
		if (!fs.existsSync(filePath)) return null;
		const raw = fs.readFileSync(filePath, "utf8");
		const parsed = JSON.parse(raw);
		if (parsed?.version !== 1 || typeof parsed.deviceId !== "string" || typeof parsed.publicKeyPem !== "string" || typeof parsed.privateKeyPem !== "string") return null;
		const derivedId = fingerprintPublicKey(parsed.publicKeyPem);
		if (!derivedId || derivedId !== parsed.deviceId) return null;
		return {
			deviceId: parsed.deviceId,
			publicKeyPem: parsed.publicKeyPem,
			privateKeyPem: parsed.privateKeyPem
		};
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
