import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import "./string-coerce-runtime-BAEEbdFW.js";
//#region extensions/browser/src/browser/bridge-auth-registry.ts
const authByPort = /* @__PURE__ */ new Map();
function setBridgeAuthForPort(port, auth) {
	if (!Number.isFinite(port) || port <= 0) return;
	const token = normalizeOptionalString(auth.token) ?? "";
	const password = normalizeOptionalString(auth.password) ?? "";
	authByPort.set(port, {
		token: token || void 0,
		password: password || void 0
	});
}
function getBridgeAuthForPort(port) {
	if (!Number.isFinite(port) || port <= 0) return;
	return authByPort.get(port);
}
function deleteBridgeAuthForPort(port) {
	if (!Number.isFinite(port) || port <= 0) return;
	authByPort.delete(port);
}
//#endregion
export { getBridgeAuthForPort as n, setBridgeAuthForPort as r, deleteBridgeAuthForPort as t };
