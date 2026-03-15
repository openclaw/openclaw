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
import { T as SYNTHETIC_DEFAULT_MODEL_REF, v as buildSyntheticProvider } from "../../models-config.providers.static-DRBnLpDj.js";
import "../../models-config.providers.discovery-l-LpSxGW.js";
import "../../pairing-token-DKpN4qO0.js";
import "../../query-expansion-txqQdNIf.js";
import "../../redact-BefI-5cC.js";
import "../../mime-33LCeGh-.js";
import "../../typebox-BmZP6XXv.js";
import "../../web-search-plugin-factory-DStYVW2B.js";
import { d as applySyntheticConfig } from "../../onboard-auth.config-core-RGiehkaJ.js";
import "../../onboard-auth.models-DgQQVW6a.js";
import "../../onboard-auth.config-minimax-CHFiQ6wX.js";
import "../../onboard-auth.config-opencode-BJ8anUQU.js";
import "../../onboard-auth-DCHJrlNU.js";
import { t as createProviderApiKeyAuthMethod } from "../../provider-api-key-auth-C_oZ2YEn.js";
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
