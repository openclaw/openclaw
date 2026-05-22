import { t as runStatusJsonCommand } from "./status-json-command-DtpR1Fc9.js";
import { t as scanStatusJsonFast } from "./status.scan.fast-json-CzRwyLY0.js";
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
