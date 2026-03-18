import "../../provider-env-vars-BfZUtZAn.js";
import { t as emptyPluginConfigSchema } from "../../config-schema-DpOJkOlS.js";
import "../../resolve-route-CQsiaDZO.js";
import "../../logger-BOdgfoqz.js";
import "../../tmp-openclaw-dir-DgEKZnX6.js";
import "../../paths-CbmqEZIn.js";
import "../../subsystem-CsPxmH8p.js";
import "../../utils-CMc9mmF8.js";
import "../../fetch-BgkAjqxB.js";
import "../../retry-CgLvWye-.js";
import "../../agent-scope-CM8plEdu.js";
import "../../exec-CWMR162-.js";
import "../../logger-C833gw0R.js";
import "../../core-CUbPSeQH.js";
import "../../paths-DAoqckDF.js";
import "../../auth-profiles-B70DPAVa.js";
import "../../profiles-BC4VpDll.js";
import "../../fetch-BX2RRCzB.js";
import "../../external-content-CxoN_TKD.js";
import "../../kilocode-shared-Ci8SRxXc.js";
import "../../models-config.providers.static-DRBnLpDj.js";
import { t as buildHuggingfaceProvider } from "../../models-config.providers.discovery-gVOHvGnm.js";
import "../../pairing-token-Do-E3rL5.js";
import "../../query-expansion-Do6vyPvH.js";
import "../../redact-BZcL_gJG.js";
import "../../mime-33LCeGh-.js";
import "../../typebox-B4kR5eyM.js";
import "../../web-search-plugin-factory-CeUlA68v.js";
import { b as HUGGINGFACE_DEFAULT_MODEL_REF, t as applyHuggingfaceConfig } from "../../onboard-auth.config-core-C8O7u8CI.js";
import "../../onboard-auth.models-DU-07n1Q.js";
import "../../onboard-auth.config-minimax-BZLhwFh4.js";
import "../../onboard-auth.config-opencode-CPtsorYE.js";
import "../../onboard-auth-D_nBXMz2.js";
import { t as createProviderApiKeyAuthMethod } from "../../provider-api-key-auth-8PSAQte9.js";
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
