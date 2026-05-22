import { o as resolveAllowFromFilePath } from "./allow-from-store-file-C3uzgk-s.js";
//#region src/pairing/allow-from-store-read.ts
function resolveChannelAllowFromPath(channel, env = process.env, accountId) {
	return resolveAllowFromFilePath(channel, env, accountId);
}
//#endregion
export { resolveChannelAllowFromPath as t };
