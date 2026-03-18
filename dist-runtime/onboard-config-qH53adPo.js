//#region src/commands/onboard-config.ts
const ONBOARDING_DEFAULT_DM_SCOPE = "per-channel-peer";
const ONBOARDING_DEFAULT_TOOLS_PROFILE = "coding";
function applyLocalSetupWorkspaceConfig(baseConfig, workspaceDir) {
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
export { ONBOARDING_DEFAULT_TOOLS_PROFILE as n, applyLocalSetupWorkspaceConfig as r, ONBOARDING_DEFAULT_DM_SCOPE as t };
