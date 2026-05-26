import { i as parseStrictPositiveInteger } from "./parse-finite-number-C3Woj8eC.js";
//#region src/cli/shared/parse-port.ts
const MAX_TCP_PORT = 65535;
function parsePort(raw) {
	if (raw === void 0 || raw === null) return null;
	const parsed = parseStrictPositiveInteger(raw);
	if (parsed === void 0 || parsed > MAX_TCP_PORT) return null;
	return parsed;
}
//#endregion
export { parsePort as t };
