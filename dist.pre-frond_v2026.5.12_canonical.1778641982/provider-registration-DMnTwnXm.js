import { t as createProviderApiKeyAuthMethod } from "./provider-api-key-auth-4LkKTmj0.js";
import "./provider-auth-api-key-4oSOW7im.js";
import { n as applyFalConfig, t as FAL_DEFAULT_IMAGE_MODEL_REF } from "./onboard-CiU21b9X.js";
//#region extensions/fal/provider-registration.ts
const PROVIDER_ID = "fal";
function createFalProvider() {
	return {
		id: PROVIDER_ID,
		label: "fal",
		docsPath: "/providers/models",
		envVars: ["FAL_KEY"],
		auth: [createProviderApiKeyAuthMethod({
			providerId: PROVIDER_ID,
			methodId: "api-key",
			label: "fal API key",
			hint: "Image and video generation API key",
			optionKey: "falApiKey",
			flagName: "--fal-api-key",
			envVar: "FAL_KEY",
			promptMessage: "Enter fal API key",
			defaultModel: FAL_DEFAULT_IMAGE_MODEL_REF,
			expectedProviders: ["fal"],
			applyConfig: (cfg) => applyFalConfig(cfg),
			wizard: {
				choiceId: "fal-api-key",
				choiceLabel: "fal API key",
				choiceHint: "Image and video generation API key",
				groupId: "fal",
				groupLabel: "fal",
				groupHint: "Image and video generation",
				onboardingScopes: ["image-generation"]
			}
		})]
	};
}
//#endregion
export { createFalProvider as t };
