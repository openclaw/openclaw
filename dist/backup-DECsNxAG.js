import { t as createLazyImportLoader } from "./lazy-promise-SFT4i6yI.js";
import { r as writeRuntimeJson } from "./runtime-DDH_zqCr.js";
import { n as formatBackupCreateSummary, t as createBackupArchive } from "./backup-create-CVDvz3s-.js";
//#region src/commands/backup.ts
const backupVerifyRuntimeLoader = createLazyImportLoader(() => import("./backup-verify-B6P6Jlmu.js"));
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
