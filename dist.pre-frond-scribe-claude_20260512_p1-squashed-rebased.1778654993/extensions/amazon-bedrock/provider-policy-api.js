import { r as normalizeProviderId } from "../../provider-id-BvxMxU5i.js";
import "../../provider-model-shared-Bukkx1JT.js";
import { n as resolveBedrockClaudeThinkingProfile } from "../../thinking-policy-DtojS9TN.js";
//#region extensions/amazon-bedrock/provider-policy-api.ts
function resolveThinkingProfile(params) {
	if (normalizeProviderId(params.provider) !== "amazon-bedrock") return null;
	return resolveBedrockClaudeThinkingProfile(params.modelId);
}
//#endregion
export { resolveThinkingProfile };
