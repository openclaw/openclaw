import { timingSafeEqual } from "node:crypto";
//#region src/security/secret-equal.ts
function padSecretBytes(bytes, length) {
	if (bytes.length === length) return bytes;
	const padded = Buffer.alloc(length);
	bytes.copy(padded);
	return padded;
}
function safeEqualSecret(provided, expected) {
	if (typeof provided !== "string" || typeof expected !== "string") return false;
	const providedBytes = Buffer.from(provided, "utf8");
	const expectedBytes = Buffer.from(expected, "utf8");
	const byteLength = Math.max(providedBytes.length, expectedBytes.length);
	if (byteLength === 0) return true;
	return timingSafeEqual(padSecretBytes(providedBytes, byteLength), padSecretBytes(expectedBytes, byteLength)) && providedBytes.length === expectedBytes.length;
}
//#endregion
export { safeEqualSecret as t };
