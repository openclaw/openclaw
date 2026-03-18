import { d as init_utils, o as displayPath } from "./utils-BiUV1eIQ.js";
import { Ib as createConfigIO } from "./auth-profiles-DAOR1fRn.js";
//#region src/config/logging.ts
init_utils();
function formatConfigPath(path = createConfigIO().configPath) {
	return displayPath(path);
}
function logConfigUpdated(runtime, opts = {}) {
	const path = formatConfigPath(opts.path ?? createConfigIO().configPath);
	const suffix = opts.suffix ? ` ${opts.suffix}` : "";
	runtime.log(`Updated ${path}${suffix}`);
}
//#endregion
export { logConfigUpdated as n, formatConfigPath as t };
