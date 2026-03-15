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
import { a as buildVeniceProvider, l as VENICE_DEFAULT_MODEL_REF } from "../../models-config.providers.discovery-l-LpSxGW.js";
import "../../pairing-token-DKpN4qO0.js";
import "../../query-expansion-txqQdNIf.js";
import "../../redact-BefI-5cC.js";
import "../../mime-33LCeGh-.js";
import "../../typebox-BmZP6XXv.js";
import "../../web-search-plugin-factory-DStYVW2B.js";
import { p as applyVeniceConfig } from "../../onboard-auth.config-core-RGiehkaJ.js";
import "../../onboard-auth.models-DgQQVW6a.js";
import "../../onboard-auth.config-minimax-CHFiQ6wX.js";
import "../../onboard-auth.config-opencode-BJ8anUQU.js";
import "../../onboard-auth-DCHJrlNU.js";
import { t as createProviderApiKeyAuthMethod } from "../../provider-api-key-auth-C_oZ2YEn.js";
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
