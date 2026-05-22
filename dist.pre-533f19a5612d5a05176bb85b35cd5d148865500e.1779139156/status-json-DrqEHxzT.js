import { t as runStatusJsonCommand } from "./status-json-command-Bb87Y0dl.js";
import { t as scanStatusJsonFast } from "./status.scan.fast-json-Dp-1i9tN.js";
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
