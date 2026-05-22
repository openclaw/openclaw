import { g as resolveOAuthDir, o as resolveConfigPath, v as resolveStateDir } from "./paths-Cnwfh6dH.js";
import { i as getRuntimeConfig } from "./io-DxVmbF3R.js";
import "./config-CBeYX-pH.js";
import { t as buildCleanupPlan } from "./cleanup-utils-D5PH3ew3.js";
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
