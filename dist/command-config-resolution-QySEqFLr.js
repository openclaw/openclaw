import { t as applyPluginAutoEnable } from "./plugin-auto-enable-CuCUT4Z1.js";
import { t as resolveCommandSecretRefsViaGateway } from "./command-secret-gateway-BpOVXOFV.js";
//#region src/cli/command-config-resolution.ts
async function resolveCommandConfigWithSecrets(params) {
	const { resolvedConfig, diagnostics } = await resolveCommandSecretRefsViaGateway({
		config: params.config,
		commandName: params.commandName,
		targetIds: params.targetIds,
		...params.mode ? { mode: params.mode } : {},
		...params.allowedPaths ? { allowedPaths: params.allowedPaths } : {},
		...params.forcedActivePaths ? { forcedActivePaths: params.forcedActivePaths } : {},
		...params.optionalActivePaths ? { optionalActivePaths: params.optionalActivePaths } : {}
	});
	if (params.runtime) for (const entry of diagnostics) params.runtime.error(`[secrets] ${entry}`);
	return {
		resolvedConfig,
		effectiveConfig: params.autoEnable ? applyPluginAutoEnable({
			config: resolvedConfig,
			env: params.env ?? process.env
		}).config : resolvedConfig,
		diagnostics
	};
}
//#endregion
export { resolveCommandConfigWithSecrets as t };
