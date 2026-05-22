import { n as resolveAwsSdkEnvVarName } from "./model-auth-runtime-shared-MFq_5ETz.js";
import "./provider-auth-runtime-CET2XIMo.js";
//#region extensions/amazon-bedrock/discovery-shared.ts
function resolveBedrockConfigApiKey(env = process.env) {
	return resolveAwsSdkEnvVarName(env);
}
function mergeImplicitBedrockProvider(params) {
	const { existing, implicit } = params;
	if (!existing) return implicit;
	return {
		...implicit,
		...existing,
		models: Array.isArray(existing.models) && existing.models.length > 0 ? existing.models : implicit.models
	};
}
//#endregion
export { resolveBedrockConfigApiKey as n, mergeImplicitBedrockProvider as t };
