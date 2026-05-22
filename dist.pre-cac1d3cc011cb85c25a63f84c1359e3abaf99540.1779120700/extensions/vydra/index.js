import { t as createProviderApiKeyAuthMethod } from "../../provider-api-key-auth-D0Py5oD2.js";
import { t as definePluginEntry } from "../../plugin-entry-BHxvLKTc.js";
import "../../provider-auth-api-key-BnRWKG0N.js";
import { t as buildVydraImageGenerationProvider } from "../../image-generation-provider-CFRln7q4.js";
import { n as applyVydraConfig, t as VYDRA_DEFAULT_IMAGE_MODEL_REF } from "../../onboard-C688XsdV.js";
import { t as buildVydraSpeechProvider } from "../../speech-provider-CV_qrJaX.js";
import { t as buildVydraVideoGenerationProvider } from "../../video-generation-provider-BKeI_wqD.js";
//#region extensions/vydra/index.ts
const PROVIDER_ID = "vydra";
var vydra_default = definePluginEntry({
	id: PROVIDER_ID,
	name: "Vydra Provider",
	description: "Bundled Vydra image, video, and speech provider",
	register(api) {
		api.registerProvider({
			id: PROVIDER_ID,
			label: "Vydra",
			docsPath: "/providers/vydra",
			envVars: ["VYDRA_API_KEY"],
			auth: [createProviderApiKeyAuthMethod({
				providerId: PROVIDER_ID,
				methodId: "api-key",
				label: "Vydra API key",
				hint: "Image, video, and speech API key",
				optionKey: "vydraApiKey",
				flagName: "--vydra-api-key",
				envVar: "VYDRA_API_KEY",
				promptMessage: "Enter Vydra API key",
				defaultModel: VYDRA_DEFAULT_IMAGE_MODEL_REF,
				expectedProviders: [PROVIDER_ID],
				applyConfig: (cfg) => applyVydraConfig(cfg),
				wizard: {
					choiceId: "vydra-api-key",
					choiceLabel: "Vydra API key",
					choiceHint: "Image, video, and speech API key",
					groupId: "vydra",
					groupLabel: "Vydra",
					groupHint: "Image, video, and speech",
					onboardingScopes: ["image-generation"]
				}
			})]
		});
		api.registerSpeechProvider(buildVydraSpeechProvider());
		api.registerImageGenerationProvider(buildVydraImageGenerationProvider());
		api.registerVideoGenerationProvider(buildVydraVideoGenerationProvider());
	}
});
//#endregion
export { vydra_default as default };
