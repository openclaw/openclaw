import { t as runStatusJsonCommand } from "./status-json-command-BcZmy3no.js";
import { t as scanStatusJsonFast } from "./status.scan.fast-json-Cg-_wgxL.js";
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
