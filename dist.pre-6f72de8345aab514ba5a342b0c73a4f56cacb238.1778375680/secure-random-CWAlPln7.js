import { n as init_dist_node, r as v7 } from "./dist-node-BR0P-7pt.js";
import { randomBytes, randomInt, randomUUID } from "node:crypto";
//#region src/infra/secure-random.ts
init_dist_node();
function generateSecureUuid() {
	return randomUUID();
}
/**
* Returns a UUIDv7 (RFC 9562) — time-ordered 128-bit identifier whose
* first 48 bits are the unix-milliseconds timestamp at mint time. Used
* for `SessionEntry.continuationChainId`: chain.id is minted on the 0->1
* transition of `continuationChainCount` and stays stable for the lifetime of
* the chain, so journal greps + sort-by-id give chronological order without a
* separate timestamp lookup.
*
* Why v7 and not v4: lexicographic ordering preserved across mints,
* downstream OTEL collectors (Jaeger/Tempo) parse UUID-shape natively,
* and `uuid@14` is already a direct dependency.
*/
function generateChainId() {
	return v7();
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
export { generateSecureToken as a, generateSecureInt as i, generateSecureFraction as n, generateSecureUuid as o, generateSecureHex as r, generateChainId as t };
