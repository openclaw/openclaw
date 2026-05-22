import { t as runStatusJsonCommand } from "./status-json-command-_O2p-p6h.js";
import { t as scanStatusJsonFast } from "./status.scan.fast-json-BTJPh5ag.js";
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
