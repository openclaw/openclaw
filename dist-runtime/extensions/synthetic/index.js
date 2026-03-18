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
import { T as SYNTHETIC_DEFAULT_MODEL_REF, v as buildSyntheticProvider } from "../../models-config.providers.static-DRBnLpDj.js";
import "../../models-config.providers.discovery-gVOHvGnm.js";
import "../../pairing-token-Do-E3rL5.js";
import "../../query-expansion-Do6vyPvH.js";
import "../../redact-BZcL_gJG.js";
import "../../mime-33LCeGh-.js";
import "../../typebox-B4kR5eyM.js";
import "../../web-search-plugin-factory-CeUlA68v.js";
import { d as applySyntheticConfig } from "../../onboard-auth.config-core-C8O7u8CI.js";
import "../../onboard-auth.models-DU-07n1Q.js";
import "../../onboard-auth.config-minimax-BZLhwFh4.js";
import "../../onboard-auth.config-opencode-CPtsorYE.js";
import "../../onboard-auth-D_nBXMz2.js";
import { t as createProviderApiKeyAuthMethod } from "../../provider-api-key-auth-8PSAQte9.js";
//#region extensions/synthetic/index.ts
const PROVIDER_ID = "synthetic";
const syntheticPlugin = {
	id: PROVIDER_ID,
	name: "Synthetic Provider",
	description: "Bundled Synthetic provider plugin",
	configSchema: emptyPluginConfigSchema(),
	register(api) {
		api.registerProvider({
			id: PROVIDER_ID,
			label: "Synthetic",
			docsPath: "/providers/synthetic",
			envVars: ["SYNTHETIC_API_KEY"],
			auth: [createProviderApiKeyAuthMethod({
				providerId: PROVIDER_ID,
				methodId: "api-key",
				label: "Synthetic API key",
				hint: "Anthropic-compatible (multi-model)",
				optionKey: "syntheticApiKey",
				flagName: "--synthetic-api-key",
				envVar: "SYNTHETIC_API_KEY",
				promptMessage: "Enter Synthetic API key",
				defaultModel: SYNTHETIC_DEFAULT_MODEL_REF,
				expectedProviders: ["synthetic"],
				applyConfig: (cfg) => applySyntheticConfig(cfg),
				wizard: {
					choiceId: "synthetic-api-key",
					choiceLabel: "Synthetic API key",
					groupId: "synthetic",
					groupLabel: "Synthetic",
					groupHint: "Anthropic-compatible (multi-model)"
				}
			})],
			catalog: {
				order: "simple",
				run: async (ctx) => {
					const apiKey = ctx.resolveProviderApiKey(PROVIDER_ID).apiKey;
					if (!apiKey) return null;
					return { provider: {
						...buildSyntheticProvider(),
						apiKey
					} };
				}
			}
		});
	}
};
//#endregion
export { syntheticPlugin as default };
