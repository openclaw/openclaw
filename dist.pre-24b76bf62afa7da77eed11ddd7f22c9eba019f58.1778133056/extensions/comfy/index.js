import { t as createProviderApiKeyAuthMethod } from "../../provider-api-key-auth-9m5WrztS.js";
import { t as definePluginEntry } from "../../plugin-entry-uVlVsnaB.js";
import "../../provider-auth-api-key-DXwTO-Rg.js";
import { t as buildComfyImageGenerationProvider } from "../../image-generation-provider-D3KRFU7a.js";
import { t as buildComfyMusicGenerationProvider } from "../../music-generation-provider-DI5UkSV3.js";
import { t as buildComfyVideoGenerationProvider } from "../../video-generation-provider-XNSmMqtF.js";
//#region extensions/comfy/index.ts
const PROVIDER_ID = "comfy";
var comfy_default = definePluginEntry({
	id: PROVIDER_ID,
	name: "ComfyUI Provider",
	description: "Bundled ComfyUI workflow media generation provider",
	register(api) {
		api.registerProvider({
			id: PROVIDER_ID,
			label: "ComfyUI",
			docsPath: "/providers/comfy",
			envVars: ["COMFY_API_KEY", "COMFY_CLOUD_API_KEY"],
			auth: [createProviderApiKeyAuthMethod({
				providerId: PROVIDER_ID,
				methodId: "cloud-api-key",
				label: "Comfy Cloud API key",
				hint: "API key for Comfy Cloud workflow runs",
				optionKey: "comfyApiKey",
				flagName: "--comfy-api-key",
				envVar: "COMFY_API_KEY",
				promptMessage: "Enter Comfy Cloud API key",
				wizard: {
					choiceId: "comfy-cloud-api-key",
					choiceLabel: "Comfy Cloud API key",
					choiceHint: "Required for cloud workflows",
					groupId: "comfy",
					groupLabel: "ComfyUI",
					groupHint: "Local or cloud workflows",
					onboardingScopes: ["image-generation"]
				}
			})]
		});
		api.registerImageGenerationProvider(buildComfyImageGenerationProvider());
		api.registerMusicGenerationProvider(buildComfyMusicGenerationProvider());
		api.registerVideoGenerationProvider(buildComfyVideoGenerationProvider());
	}
});
//#endregion
export { comfy_default as default };
