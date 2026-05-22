import { t as runStatusJsonCommand } from "./status-json-command-DCkpKJQN.js";
import { t as scanStatusJsonFast } from "./status.scan.fast-json-B0Pm06Tk.js";
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
