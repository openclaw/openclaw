import { t as runStatusJsonCommand } from "./status-json-command-BB6I5b3s.js";
import { t as scanStatusJsonFast } from "./status.scan.fast-json-Cmjtnq50.js";
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
