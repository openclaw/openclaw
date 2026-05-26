import { randomBytes, randomInt, randomUUID } from "node:crypto";
//#region src/infra/secure-random.ts
function generateSecureUuid() {
	return randomUUID();
}
function generateSecureToken(bytes = 16) {
	return randomBytes(bytes).toString("base64url");
}
function generateSecureHex(bytes = 16) {
	return randomBytes(bytes).toString("hex");
}
/** Returns a cryptographically secure fraction in the range [0, 1). */
function generateSecureFraction() {
	return randomBytes(4).readUInt32BE(0) / 4294967296;
}
function generateSecureInt(a, b) {
	return typeof b === "number" ? randomInt(a, b) : randomInt(a);
}
//#endregion
export { generateSecureUuid as a, generateSecureToken as i, generateSecureHex as n, generateSecureInt as r, generateSecureFraction as t };
