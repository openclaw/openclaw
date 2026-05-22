import { t as runStatusJsonCommand } from "./status-json-command-DJ1J0b0u.js";
import { t as scanStatusJsonFast } from "./status.scan.fast-json-DsS5sq47.js";
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
