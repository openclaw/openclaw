import "../../provider-env-vars-BfZUtZAn.js";
import { t as emptyPluginConfigSchema } from "../../config-schema-DpOJkOlS.js";
import "../../resolve-route-BZ4hHpx2.js";
import "../../logger-CRwcgB9y.js";
import "../../tmp-openclaw-dir-Bz3ouN_i.js";
import "../../paths-Byjx7_T6.js";
import "../../subsystem-CsP80x3t.js";
import "../../utils-o1tyfnZ_.js";
import "../../fetch-Dx857jUp.js";
import "../../retry-BY_ggjbn.js";
import "../../agent-scope-DV_aCIyi.js";
import "../../exec-BLi45_38.js";
import "../../logger-Bsnck4bK.js";
import "../../core-qWFcsWSH.js";
import "../../paths-OqPpu-UR.js";
import "../../auth-profiles-CuJtivJK.js";
import "../../profiles-CV7WLKIX.js";
import "../../fetch-D2ZOzaXt.js";
import "../../external-content-vZzOHxnd.js";
import "../../kilocode-shared-Ci8SRxXc.js";
import "../../models-config.providers.static-DRBnLpDj.js";
import { t as buildHuggingfaceProvider } from "../../models-config.providers.discovery-l-LpSxGW.js";
import "../../pairing-token-DKpN4qO0.js";
import "../../query-expansion-txqQdNIf.js";
import "../../redact-BefI-5cC.js";
import "../../mime-33LCeGh-.js";
import "../../typebox-BmZP6XXv.js";
import "../../web-search-plugin-factory-DStYVW2B.js";
import { b as HUGGINGFACE_DEFAULT_MODEL_REF, t as applyHuggingfaceConfig } from "../../onboard-auth.config-core-RGiehkaJ.js";
import "../../onboard-auth.models-DgQQVW6a.js";
import "../../onboard-auth.config-minimax-CHFiQ6wX.js";
import "../../onboard-auth.config-opencode-BJ8anUQU.js";
import "../../onboard-auth-DCHJrlNU.js";
import { t as createProviderApiKeyAuthMethod } from "../../provider-api-key-auth-C_oZ2YEn.js";
//#region extensions/huggingface/index.ts
const PROVIDER_ID = "huggingface";
const huggingfacePlugin = {
	id: PROVIDER_ID,
	name: "Hugging Face Provider",
	description: "Bundled Hugging Face provider plugin",
	configSchema: emptyPluginConfigSchema(),
	register(api) {
		api.registerProvider({
			id: PROVIDER_ID,
			label: "Hugging Face",
			docsPath: "/providers/huggingface",
			envVars: ["HUGGINGFACE_HUB_TOKEN", "HF_TOKEN"],
			auth: [createProviderApiKeyAuthMethod({
				providerId: PROVIDER_ID,
				methodId: "api-key",
				label: "Hugging Face API key",
				hint: "Inference API (HF token)",
				optionKey: "huggingfaceApiKey",
				flagName: "--huggingface-api-key",
				envVar: "HUGGINGFACE_HUB_TOKEN",
				promptMessage: "Enter Hugging Face API key",
				defaultModel: HUGGINGFACE_DEFAULT_MODEL_REF,
				expectedProviders: ["huggingface"],
				applyConfig: (cfg) => applyHuggingfaceConfig(cfg),
				wizard: {
					choiceId: "huggingface-api-key",
					choiceLabel: "Hugging Face API key",
					choiceHint: "Inference API (HF token)",
					groupId: "huggingface",
					groupLabel: "Hugging Face",
					groupHint: "Inference API (HF token)"
				}
			})],
			catalog: {
				order: "simple",
				run: async (ctx) => {
					const { apiKey, discoveryApiKey } = ctx.resolveProviderApiKey(PROVIDER_ID);
					if (!apiKey) return null;
					return { provider: {
						...await buildHuggingfaceProvider(discoveryApiKey),
						apiKey
					} };
				}
			}
		});
	}
};
//#endregion
export { huggingfacePlugin as default };
