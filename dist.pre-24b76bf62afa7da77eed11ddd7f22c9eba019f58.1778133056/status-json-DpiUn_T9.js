import { t as runStatusJsonCommand } from "./status-json-command-Cunoxr7m.js";
import { t as scanStatusJsonFast } from "./status.scan.fast-json-B_55CtqV.js";
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
