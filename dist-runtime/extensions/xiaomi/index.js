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
import { Hn as PROVIDER_LABELS } from "../../auth-profiles-CuJtivJK.js";
import "../../profiles-CV7WLKIX.js";
import "../../fetch-D2ZOzaXt.js";
import "../../external-content-vZzOHxnd.js";
import "../../kilocode-shared-Ci8SRxXc.js";
import { b as buildXiaomiProvider } from "../../models-config.providers.static-DRBnLpDj.js";
import "../../models-config.providers.discovery-l-LpSxGW.js";
import "../../pairing-token-DKpN4qO0.js";
import "../../query-expansion-txqQdNIf.js";
import "../../redact-BefI-5cC.js";
import "../../mime-33LCeGh-.js";
import "../../typebox-BmZP6XXv.js";
import "../../web-search-plugin-factory-DStYVW2B.js";
import { h as applyXiaomiConfig, w as XIAOMI_DEFAULT_MODEL_REF } from "../../onboard-auth.config-core-RGiehkaJ.js";
import "../../onboard-auth.models-DgQQVW6a.js";
import "../../onboard-auth.config-minimax-CHFiQ6wX.js";
import "../../onboard-auth.config-opencode-BJ8anUQU.js";
import "../../onboard-auth-DCHJrlNU.js";
import { t as createProviderApiKeyAuthMethod } from "../../provider-api-key-auth-C_oZ2YEn.js";
//#region extensions/xiaomi/index.ts
const PROVIDER_ID = "xiaomi";
const xiaomiPlugin = {
	id: PROVIDER_ID,
	name: "Xiaomi Provider",
	description: "Bundled Xiaomi provider plugin",
	configSchema: emptyPluginConfigSchema(),
	register(api) {
		api.registerProvider({
			id: PROVIDER_ID,
			label: "Xiaomi",
			docsPath: "/providers/xiaomi",
			envVars: ["XIAOMI_API_KEY"],
			auth: [createProviderApiKeyAuthMethod({
				providerId: PROVIDER_ID,
				methodId: "api-key",
				label: "Xiaomi API key",
				hint: "API key",
				optionKey: "xiaomiApiKey",
				flagName: "--xiaomi-api-key",
				envVar: "XIAOMI_API_KEY",
				promptMessage: "Enter Xiaomi API key",
				defaultModel: XIAOMI_DEFAULT_MODEL_REF,
				expectedProviders: ["xiaomi"],
				applyConfig: (cfg) => applyXiaomiConfig(cfg),
				wizard: {
					choiceId: "xiaomi-api-key",
					choiceLabel: "Xiaomi API key",
					groupId: "xiaomi",
					groupLabel: "Xiaomi",
					groupHint: "API key"
				}
			})],
			catalog: {
				order: "simple",
				run: async (ctx) => {
					const apiKey = ctx.resolveProviderApiKey(PROVIDER_ID).apiKey;
					if (!apiKey) return null;
					return { provider: {
						...buildXiaomiProvider(),
						apiKey
					} };
				}
			},
			resolveUsageAuth: async (ctx) => {
				const apiKey = ctx.resolveApiKeyFromConfigAndStore({ envDirect: [ctx.env.XIAOMI_API_KEY] });
				return apiKey ? { token: apiKey } : null;
			},
			fetchUsageSnapshot: async () => ({
				provider: "xiaomi",
				displayName: PROVIDER_LABELS.xiaomi,
				windows: []
			})
		});
	}
};
//#endregion
export { xiaomiPlugin as default };
