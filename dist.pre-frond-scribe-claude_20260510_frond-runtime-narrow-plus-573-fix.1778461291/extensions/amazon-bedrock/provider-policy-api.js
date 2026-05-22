import { r as normalizeProviderId } from "../../provider-id-C3dkeX_L.js";
import "../../provider-model-shared-BJrHvRZi.js";
import { n as resolveBedrockClaudeThinkingProfile } from "../../thinking-policy-CBtFS26z.js";
//#region extensions/amazon-bedrock/provider-policy-api.ts
function resolveThinkingProfile(params) {
	if (normalizeProviderId(params.provider) !== "amazon-bedrock") return null;
	return resolveBedrockClaudeThinkingProfile(params.modelId);
}
//#endregion
export { resolveThinkingProfile };
