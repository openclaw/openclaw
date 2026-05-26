import { r as theme } from "./theme-D58JpUfy.js";
import { a as displayPath } from "./utils-sBTEdeml.js";
import { r as createConfigIO } from "./io-DoswVvYe.js";
import fs from "node:fs";
//#region src/config/logging.ts
function formatConfigPath(path = createConfigIO().configPath) {
	return displayPath(path);
}
function formatConfigUpdatedMessage(path, opts = {}) {
	const displayConfigPath = theme.muted(formatConfigPath(path));
	const suffix = opts.suffix ? ` ${opts.suffix}` : "";
	const backupPath = opts.backupPath === void 0 ? `${path}.bak` : opts.backupPath;
	const lines = [`Updated config: ${displayConfigPath}${suffix}`];
	if (backupPath && fs.existsSync(backupPath)) lines.push(`  Backup: ${theme.muted(formatConfigPath(backupPath))}`);
	return lines.join("\n");
}
function logConfigUpdated(runtime, opts = {}) {
	runtime.log(formatConfigUpdatedMessage(opts.path ?? createConfigIO().configPath, opts));
}
//#endregion
export { formatConfigUpdatedMessage as n, logConfigUpdated as r, formatConfigPath as t };
