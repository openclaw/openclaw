import { n as isWSL2Sync } from "./wsl-BJkxH6R1.js";
import * as net$1 from "node:net";
//#region src/infra/net/undici-family-policy.ts
const AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS = 300;
function resolveUndiciAutoSelectFamily() {
	if (typeof net$1.getDefaultAutoSelectFamily !== "function") return;
	try {
		const systemDefault = net$1.getDefaultAutoSelectFamily();
		if (systemDefault && isWSL2Sync()) return false;
		return systemDefault;
	} catch {
		return;
	}
}
function createUndiciAutoSelectFamilyConnectOptions(autoSelectFamily) {
	if (autoSelectFamily === void 0) return;
	return {
		autoSelectFamily,
		autoSelectFamilyAttemptTimeout: AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS
	};
}
function resolveUndiciAutoSelectFamilyConnectOptions() {
	return createUndiciAutoSelectFamilyConnectOptions(resolveUndiciAutoSelectFamily());
}
//#endregion
export { resolveUndiciAutoSelectFamily as n, resolveUndiciAutoSelectFamilyConnectOptions as r, createUndiciAutoSelectFamilyConnectOptions as t };
