import { t as createProviderApiKeyAuthMethod } from "./provider-api-key-auth-E_5Yag4W.js";
import "./provider-auth-api-key-C06h8GOX.js";
import { n as applyFalConfig, t as FAL_DEFAULT_IMAGE_MODEL_REF } from "./onboard-BkL2fEZv.js";
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
			hint: "Image, video, and music generation API key",
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
				choiceHint: "Image, video, and music generation API key",
				groupId: "fal",
				groupLabel: "fal",
				groupHint: "Image, video, and music generation",
				onboardingScopes: ["image-generation", "music-generation"]
			}
		})]
	};
}
//#endregion
export { createFalProvider as t };
