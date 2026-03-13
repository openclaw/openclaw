import { t as __exportAll } from "./rolldown-runtime-DUslC3ob.js";
//#region src/commands/onboard-config.ts
var onboard_config_exports = /* @__PURE__ */ __exportAll({
	ONBOARDING_DEFAULT_DM_SCOPE: () => ONBOARDING_DEFAULT_DM_SCOPE,
	ONBOARDING_DEFAULT_TOOLS_PROFILE: () => ONBOARDING_DEFAULT_TOOLS_PROFILE,
	applyOnboardingLocalWorkspaceConfig: () => applyOnboardingLocalWorkspaceConfig
});
const ONBOARDING_DEFAULT_DM_SCOPE = "per-channel-peer";
const ONBOARDING_DEFAULT_TOOLS_PROFILE = "coding";
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
			dmScope: baseConfig.session?.dmScope ?? "per-channel-peer"
		},
		tools: {
			...baseConfig.tools,
			profile: baseConfig.tools?.profile ?? "coding"
		}
	};
}
//#endregion
export { onboard_config_exports as n, applyOnboardingLocalWorkspaceConfig as t };
