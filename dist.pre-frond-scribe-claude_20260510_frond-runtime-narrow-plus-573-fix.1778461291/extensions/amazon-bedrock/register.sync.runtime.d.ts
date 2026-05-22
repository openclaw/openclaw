import { g as OpenClawPluginApi } from "../../types-BYigPDoy.js";
//#region extensions/amazon-bedrock/register.sync.runtime.d.ts
type BedrockGetInferenceProfileResponse = {
  models?: Array<{
    modelArn?: string;
  }>;
};
type BedrockControlPlane = {
  getInferenceProfile: (input: {
    inferenceProfileIdentifier: string;
  }) => Promise<BedrockGetInferenceProfileResponse>;
};
type BedrockControlPlaneFactory = (region: string | undefined) => BedrockControlPlane;
declare function resetBedrockAppProfileCacheEligibilityForTest(): void;
declare function setBedrockAppProfileControlPlaneForTest(controlPlane: BedrockControlPlaneFactory | undefined): void;
declare function registerAmazonBedrockPlugin(api: OpenClawPluginApi): void;
//#endregion
export { registerAmazonBedrockPlugin, resetBedrockAppProfileCacheEligibilityForTest, setBedrockAppProfileControlPlaneForTest };