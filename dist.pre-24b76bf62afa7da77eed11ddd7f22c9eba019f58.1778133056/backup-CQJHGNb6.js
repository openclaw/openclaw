import { t as createLazyImportLoader } from "./lazy-promise-BWWZqHu4.js";
import { r as writeRuntimeJson } from "./runtime-CFpTi2zA.js";
import { n as formatBackupCreateSummary, t as createBackupArchive } from "./backup-create-B0pk8-k9.js";
//#region src/commands/backup.ts
const backupVerifyRuntimeLoader = createLazyImportLoader(() => import("./backup-verify-DEIHjrNO.js"));
function loadBackupVerifyRuntime() {
	return backupVerifyRuntimeLoader.load();
}
async function backupCreateCommand(runtime, opts = {}) {
	const result = await createBackupArchive(opts);
	if (opts.verify && !opts.dryRun) {
		const { backupVerifyCommand } = await loadBackupVerifyRuntime();
		await backupVerifyCommand({
			...runtime,
			log: () => {}
		}, {
			archive: result.archivePath,
			json: false
		});
		result.verified = true;
	}
	if (opts.json) writeRuntimeJson(runtime, result);
	else runtime.log(formatBackupCreateSummary(result).join("\n"));
	return result;
}
//#endregion
export { backupCreateCommand as t };
