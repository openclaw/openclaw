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
import { _ as buildQianfanProvider } from "../../models-config.providers.static-DRBnLpDj.js";
import "../../models-config.providers.discovery-gVOHvGnm.js";
import "../../pairing-token-Do-E3rL5.js";
import "../../query-expansion-Do6vyPvH.js";
import "../../redact-BZcL_gJG.js";
import "../../mime-33LCeGh-.js";
import "../../typebox-B4kR5eyM.js";
import "../../web-search-plugin-factory-CeUlA68v.js";
import { u as applyQianfanConfig } from "../../onboard-auth.config-core-C8O7u8CI.js";
import { h as QIANFAN_DEFAULT_MODEL_REF } from "../../onboard-auth.models-DU-07n1Q.js";
import "../../onboard-auth.config-minimax-BZLhwFh4.js";
import "../../onboard-auth.config-opencode-CPtsorYE.js";
import "../../onboard-auth-D_nBXMz2.js";
import { t as createProviderApiKeyAuthMethod } from "../../provider-api-key-auth-8PSAQte9.js";
//#region extensions/qianfan/index.ts
const PROVIDER_ID = "qianfan";
const qianfanPlugin = {
	id: PROVIDER_ID,
	name: "Qianfan Provider",
	description: "Bundled Qianfan provider plugin",
	configSchema: emptyPluginConfigSchema(),
	register(api) {
		api.registerProvider({
			id: PROVIDER_ID,
			label: "Qianfan",
			docsPath: "/providers/qianfan",
			envVars: ["QIANFAN_API_KEY"],
			auth: [createProviderApiKeyAuthMethod({
				providerId: PROVIDER_ID,
				methodId: "api-key",
				label: "Qianfan API key",
				hint: "API key",
				optionKey: "qianfanApiKey",
				flagName: "--qianfan-api-key",
				envVar: "QIANFAN_API_KEY",
				promptMessage: "Enter Qianfan API key",
				defaultModel: QIANFAN_DEFAULT_MODEL_REF,
				expectedProviders: ["qianfan"],
				applyConfig: (cfg) => applyQianfanConfig(cfg),
				wizard: {
					choiceId: "qianfan-api-key",
					choiceLabel: "Qianfan API key",
					groupId: "qianfan",
					groupLabel: "Qianfan",
					groupHint: "API key"
				}
			})],
			catalog: {
				order: "simple",
				run: async (ctx) => {
					const apiKey = ctx.resolveProviderApiKey(PROVIDER_ID).apiKey;
					if (!apiKey) return null;
					return { provider: {
						...buildQianfanProvider(),
						apiKey
					} };
				}
			}
		});
	}
};
//#endregion
export { qianfanPlugin as default };
