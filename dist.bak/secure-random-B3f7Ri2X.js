import { randomBytes, randomUUID } from "node:crypto";

//#region src/infra/secure-random.ts
function generateSecureUuid() {
	return randomUUID();
}
function generateSecureToken(bytes = 16) {
	return randomBytes(bytes).toString("base64url");
}

//#endregion
export { generateSecureUuid as n, generateSecureToken as t };