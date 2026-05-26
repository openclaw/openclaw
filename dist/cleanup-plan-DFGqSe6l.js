import { _ as resolveOAuthDir, s as resolveConfigPath, y as resolveStateDir } from "./paths-Cw7f9XhU.js";
import { i as getRuntimeConfig } from "./io-DoswVvYe.js";
import "./config-B6Oplu5W.js";
import { t as buildCleanupPlan } from "./cleanup-utils-CcUSEU7z.js";
//#region src/commands/cleanup-plan.ts
function resolveCleanupPlanFromDisk() {
	const cfg = getRuntimeConfig();
	const stateDir = resolveStateDir();
	const configPath = resolveConfigPath();
	const oauthDir = resolveOAuthDir();
	return {
		cfg,
		stateDir,
		configPath,
		oauthDir,
		...buildCleanupPlan({
			cfg,
			stateDir,
			configPath,
			oauthDir
		})
	};
}
//#endregion
export { resolveCleanupPlanFromDisk as t };
