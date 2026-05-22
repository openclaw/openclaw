import { r as normalizeProviderId } from "../../provider-id-Cz7K6wgK.js";
import "../../provider-model-shared-BMpmkx54.js";
import { n as resolveBedrockClaudeThinkingProfile } from "../../thinking-policy-AVaqWcWG.js";
//#region extensions/amazon-bedrock/provider-policy-api.ts
function resolveThinkingProfile(params) {
	if (normalizeProviderId(params.provider) !== "amazon-bedrock") return null;
	return resolveBedrockClaudeThinkingProfile(params.modelId);
}
//#endregion
export { resolveThinkingProfile };
