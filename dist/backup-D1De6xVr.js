import { t as createLazyImportLoader } from "./lazy-promise-Djskx0qC.js";
import { r as writeRuntimeJson } from "./runtime-yzlkhCoS.js";
import { n as formatBackupCreateSummary, t as createBackupArchive } from "./backup-create-55pNMYiW.js";
//#region src/commands/backup.ts
const backupVerifyRuntimeLoader = createLazyImportLoader(() => import("./backup-verify-BMyTAH0M.js"));
function loadBackupVerifyRuntime() {
	return backupVerifyRuntimeLoader.load();
}
async function backupCreateCommand(runtime, opts = {}) {
	const result = await createBackupArchive({
		...opts,
		log: opts.log ?? (opts.json ? void 0 : (message) => runtime.log(message))
	});
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
