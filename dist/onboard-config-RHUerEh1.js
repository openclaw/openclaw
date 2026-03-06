import { t as __exportAll } from "./rolldown-runtime-Cbj13DAv.js";
import { r as isDevMode } from "./globals-DqM7Q4km.js";

//#region src/commands/onboard-config.ts
var onboard_config_exports = /* @__PURE__ */ __exportAll({
	ONBOARDING_DEFAULT_DM_SCOPE: () => ONBOARDING_DEFAULT_DM_SCOPE,
	ONBOARDING_DEFAULT_TOOLS_PROFILE: () => ONBOARDING_DEFAULT_TOOLS_PROFILE,
	applyOnboardingLocalWorkspaceConfig: () => applyOnboardingLocalWorkspaceConfig
});
const ONBOARDING_DEFAULT_DM_SCOPE = "per-channel-peer";
const ONBOARDING_DEFAULT_TOOLS_PROFILE = "messaging";
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
		},
		tools: {
			...baseConfig.tools,
			profile: isDevMode() ? baseConfig.tools?.profile : baseConfig.tools?.profile ?? ONBOARDING_DEFAULT_TOOLS_PROFILE
		}
	};
}

//#endregion
export { onboard_config_exports as n, applyOnboardingLocalWorkspaceConfig as t };