import { t as createProviderApiKeyAuthMethod } from "../../provider-api-key-auth-BOMeLODK.js";
import { t as definePluginEntry } from "../../plugin-entry-DFlZXTDz.js";
import "../../provider-auth-api-key-DoK1lV6d.js";
import { t as buildVydraImageGenerationProvider } from "../../image-generation-provider-BBVwiioO.js";
import { n as applyVydraConfig, t as VYDRA_DEFAULT_IMAGE_MODEL_REF } from "../../onboard-DBdjbgQK.js";
import { t as buildVydraSpeechProvider } from "../../speech-provider-BGeqhHvt.js";
import { t as buildVydraVideoGenerationProvider } from "../../video-generation-provider-C2iueY0z.js";
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
