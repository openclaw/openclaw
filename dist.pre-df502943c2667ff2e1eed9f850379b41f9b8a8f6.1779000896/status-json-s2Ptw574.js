import { t as runStatusJsonCommand } from "./status-json-command-BP-V4dpJ.js";
import { t as scanStatusJsonFast } from "./status.scan.fast-json-DHYy5-0-.js";
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
