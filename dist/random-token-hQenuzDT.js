import crypto from "node:crypto";
//#region src/commands/random-token.ts
function randomToken() {
	return crypto.randomBytes(24).toString("hex");
}
//#endregion
export { randomToken as t };
