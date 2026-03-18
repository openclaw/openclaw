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
import { a as buildVeniceProvider, l as VENICE_DEFAULT_MODEL_REF } from "../../models-config.providers.discovery-gVOHvGnm.js";
import "../../pairing-token-Do-E3rL5.js";
import "../../query-expansion-Do6vyPvH.js";
import "../../redact-BZcL_gJG.js";
import "../../mime-33LCeGh-.js";
import "../../typebox-B4kR5eyM.js";
import "../../web-search-plugin-factory-CeUlA68v.js";
import { p as applyVeniceConfig } from "../../onboard-auth.config-core-C8O7u8CI.js";
import "../../onboard-auth.models-DU-07n1Q.js";
import "../../onboard-auth.config-minimax-BZLhwFh4.js";
import "../../onboard-auth.config-opencode-CPtsorYE.js";
import "../../onboard-auth-D_nBXMz2.js";
import { t as createProviderApiKeyAuthMethod } from "../../provider-api-key-auth-8PSAQte9.js";
//#region extensions/venice/index.ts
const PROVIDER_ID = "venice";
const venicePlugin = {
	id: PROVIDER_ID,
	name: "Venice Provider",
	description: "Bundled Venice provider plugin",
	configSchema: emptyPluginConfigSchema(),
	register(api) {
		api.registerProvider({
			id: PROVIDER_ID,
			label: "Venice",
			docsPath: "/providers/venice",
			envVars: ["VENICE_API_KEY"],
			auth: [createProviderApiKeyAuthMethod({
				providerId: PROVIDER_ID,
				methodId: "api-key",
				label: "Venice AI API key",
				hint: "Privacy-focused (uncensored models)",
				optionKey: "veniceApiKey",
				flagName: "--venice-api-key",
				envVar: "VENICE_API_KEY",
				promptMessage: "Enter Venice AI API key",
				defaultModel: VENICE_DEFAULT_MODEL_REF,
				expectedProviders: ["venice"],
				applyConfig: (cfg) => applyVeniceConfig(cfg),
				noteMessage: [
					"Venice AI provides privacy-focused inference with uncensored models.",
					"Get your API key at: https://venice.ai/settings/api",
					"Supports 'private' (fully private) and 'anonymized' (proxy) modes."
				].join("\n"),
				noteTitle: "Venice AI",
				wizard: {
					choiceId: "venice-api-key",
					choiceLabel: "Venice AI API key",
					groupId: "venice",
					groupLabel: "Venice AI",
					groupHint: "Privacy-focused (uncensored models)"
				}
			})],
			catalog: {
				order: "simple",
				run: async (ctx) => {
					const apiKey = ctx.resolveProviderApiKey(PROVIDER_ID).apiKey;
					if (!apiKey) return null;
					return { provider: {
						...await buildVeniceProvider(),
						apiKey
					} };
				}
			}
		});
	}
};
//#endregion
export { venicePlugin as default };
