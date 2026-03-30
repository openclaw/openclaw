import { t as __exportAll } from "./rolldown-runtime-Cbj13DAv.js";

//#region src/commands/onboard-config.ts
var onboard_config_exports = /* @__PURE__ */ __exportAll({
	ONBOARDING_DEFAULT_DM_SCOPE: () => ONBOARDING_DEFAULT_DM_SCOPE,
	applyOnboardingLocalWorkspaceConfig: () => applyOnboardingLocalWorkspaceConfig
});
const ONBOARDING_DEFAULT_DM_SCOPE = "per-channel-peer";
function applyOnboardingLocalWorkspaceConfig(baseConfig, workspaceDir) {
	return {
		...baseConfig,
		agents: {
			...baseConfig.agents,
			defaults: {
				...baseConfig.agents?.defaults,
				workspace: workspaceDir
			}
		},
		gateway: {
			...baseConfig.gateway,
			mode: "local"
		},
		session: {
			...baseConfig.session,
			dmScope: baseConfig.session?.dmScope ?? ONBOARDING_DEFAULT_DM_SCOPE
		}
	};
}

//#endregion
export { onboard_config_exports as n, applyOnboardingLocalWorkspaceConfig as t };