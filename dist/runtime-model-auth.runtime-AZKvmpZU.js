import { a as prepareProviderRuntimeAuth } from "./provider-runtime.runtime.js";
import { i as getApiKeyForModel$1, u as resolveApiKeyForProvider$1 } from "./model-auth-Db-JGIrg.js";
//#region src/plugins/runtime/runtime-model-auth.runtime.ts
async function getApiKeyForModel(params) {
	return getApiKeyForModel$1(params);
}
async function resolveApiKeyForProvider(params) {
	return resolveApiKeyForProvider$1(params);
}
/**
* Resolve request-ready auth for a runtime model, applying any provider-owned
* `prepareRuntimeAuth` exchange on top of the standard credential lookup.
*/
async function getRuntimeAuthForModel(params) {
	const resolvedAuth = await getApiKeyForModel$1({
		model: params.model,
		cfg: params.cfg,
		workspaceDir: params.workspaceDir
	});
	if (!resolvedAuth.apiKey || resolvedAuth.mode === "aws-sdk") return resolvedAuth;
	const preparedAuth = await prepareProviderRuntimeAuth({
		provider: params.model.provider,
		config: params.cfg,
		workspaceDir: params.workspaceDir,
		env: process.env,
		context: {
			config: params.cfg,
			workspaceDir: params.workspaceDir,
			env: process.env,
			provider: params.model.provider,
			modelId: params.model.id,
			model: params.model,
			apiKey: resolvedAuth.apiKey,
			authMode: resolvedAuth.mode,
			profileId: resolvedAuth.profileId
		}
	});
	if (!preparedAuth) return resolvedAuth;
	return {
		...resolvedAuth,
		...preparedAuth,
		apiKey: preparedAuth.apiKey ?? resolvedAuth.apiKey
	};
}
//#endregion
export { getRuntimeAuthForModel as n, resolveApiKeyForProvider as r, getApiKeyForModel as t };
