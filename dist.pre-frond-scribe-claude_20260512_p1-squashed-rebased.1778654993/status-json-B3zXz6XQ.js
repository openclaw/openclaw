import { t as runStatusJsonCommand } from "./status-json-command-D0LexM2A.js";
import { t as scanStatusJsonFast } from "./status.scan.fast-json-DUC-BGl6.js";
//#region src/commands/status-json.ts
async function statusJsonCommand(opts, runtime) {
	await runStatusJsonCommand({
		opts,
		runtime,
		scanStatusJsonFast,
		includeSecurityAudit: opts.all === true,
		suppressHealthErrors: true
	});
}
//#endregion
export { statusJsonCommand };
