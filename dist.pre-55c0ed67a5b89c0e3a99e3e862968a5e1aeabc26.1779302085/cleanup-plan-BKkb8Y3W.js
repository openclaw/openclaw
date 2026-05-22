import { g as resolveOAuthDir, o as resolveConfigPath, v as resolveStateDir } from "./paths-r6w2eKyy.js";
import { i as getRuntimeConfig } from "./io-B3cB3MOo.js";
import "./config-Dh6CigU2.js";
import { t as buildCleanupPlan } from "./cleanup-utils-o35tAGv4.js";
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
