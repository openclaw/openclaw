import crypto from "node:crypto";
//#region packages/memory-host-sdk/src/host/hash.ts
function hashText(value) {
	return crypto.createHash("sha256").update(value).digest("hex");
}
//#endregion
export { hashText as t };
