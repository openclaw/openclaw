import { v as resolveStateDir } from "./paths-C1_Y0cDn.js";
import { i as getRuntimeConfig } from "./io-BqN-ccJq.js";
import "./config-Cfbn58KU.js";
import path from "node:path";
//#region src/commands/migrate/context.ts
function createMigrationLogger(runtime, opts = {}) {
	const info = opts.json ? runtime.error : runtime.log;
	return {
		debug: (message) => {
			if (process.env.OPENCLAW_VERBOSE === "1") info(message);
		},
		info: (message) => info(message),
		warn: (message) => runtime.error(message),
		error: (message) => runtime.error(message)
	};
}
function buildMigrationReportDir(providerId, stateDir, nowMs = Date.now()) {
	const stamp = new Date(nowMs).toISOString().replaceAll(":", "-");
	return path.join(stateDir, "migration", providerId, stamp);
}
function buildMigrationContext(params) {
	return {
		config: getRuntimeConfig(),
		stateDir: resolveStateDir(),
		source: params.source,
		includeSecrets: Boolean(params.includeSecrets),
		overwrite: Boolean(params.overwrite),
		backupPath: params.backupPath,
		reportDir: params.reportDir,
		logger: createMigrationLogger(params.runtime, { json: params.json })
	};
}
//#endregion
export { buildMigrationReportDir as n, createMigrationLogger as r, buildMigrationContext as t };
