import { t as runStatusJsonCommand } from "./status-json-command-V3ze5a2q.js";
import { t as scanStatusJsonFast } from "./status.scan.fast-json-YA72DNz2.js";
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
