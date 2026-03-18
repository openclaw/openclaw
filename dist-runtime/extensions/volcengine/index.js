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
import { qu as ensureModelAllowlistEntry } from "../../auth-profiles-B70DPAVa.js";
import "../../profiles-BC4VpDll.js";
import "../../fetch-BX2RRCzB.js";
import "../../external-content-CxoN_TKD.js";
import "../../kilocode-shared-Ci8SRxXc.js";
import { o as buildDoubaoCodingProvider, s as buildDoubaoProvider } from "../../models-config.providers.static-DRBnLpDj.js";
import "../../models-config.providers.discovery-gVOHvGnm.js";
import "../../pairing-token-Do-E3rL5.js";
import "../../query-expansion-Do6vyPvH.js";
import "../../redact-BZcL_gJG.js";
import "../../mime-33LCeGh-.js";
import "../../typebox-B4kR5eyM.js";
import "../../web-search-plugin-factory-CeUlA68v.js";
import { t as createProviderApiKeyAuthMethod } from "../../provider-api-key-auth-8PSAQte9.js";
//#region extensions/volcengine/index.ts
const PROVIDER_ID = "volcengine";
const VOLCENGINE_DEFAULT_MODEL_REF = "volcengine-plan/ark-code-latest";
const volcenginePlugin = {
	id: PROVIDER_ID,
	name: "Volcengine Provider",
	description: "Bundled Volcengine provider plugin",
	configSchema: emptyPluginConfigSchema(),
	register(api) {
		api.registerProvider({
			id: PROVIDER_ID,
			label: "Volcengine",
			docsPath: "/concepts/model-providers#volcano-engine-doubao",
			envVars: ["VOLCANO_ENGINE_API_KEY"],
			auth: [createProviderApiKeyAuthMethod({
				providerId: PROVIDER_ID,
				methodId: "api-key",
				label: "Volcano Engine API key",
				hint: "API key",
				optionKey: "volcengineApiKey",
				flagName: "--volcengine-api-key",
				envVar: "VOLCANO_ENGINE_API_KEY",
				promptMessage: "Enter Volcano Engine API key",
				defaultModel: VOLCENGINE_DEFAULT_MODEL_REF,
				expectedProviders: ["volcengine"],
				applyConfig: (cfg) => ensureModelAllowlistEntry({
					cfg,
					modelRef: VOLCENGINE_DEFAULT_MODEL_REF
				}),
				wizard: {
					choiceId: "volcengine-api-key",
					choiceLabel: "Volcano Engine API key",
					groupId: "volcengine",
					groupLabel: "Volcano Engine",
					groupHint: "API key"
				}
			})],
			catalog: {
				order: "paired",
				run: async (ctx) => {
					const apiKey = ctx.resolveProviderApiKey(PROVIDER_ID).apiKey;
					if (!apiKey) return null;
					return { providers: {
						volcengine: {
							...buildDoubaoProvider(),
							apiKey
						},
						"volcengine-plan": {
							...buildDoubaoCodingProvider(),
							apiKey
						}
					} };
				}
			}
		});
	}
};
//#endregion
export { volcenginePlugin as default };
