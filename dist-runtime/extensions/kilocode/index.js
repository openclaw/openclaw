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
import { a as KILOCODE_DEFAULT_MODEL_REF } from "../../kilocode-shared-Ci8SRxXc.js";
import "../../models-config.providers.static-DRBnLpDj.js";
import { n as buildKilocodeProviderWithDiscovery } from "../../models-config.providers.discovery-l-LpSxGW.js";
import "../../pairing-token-DKpN4qO0.js";
import "../../query-expansion-txqQdNIf.js";
import "../../redact-BefI-5cC.js";
import "../../mime-33LCeGh-.js";
import "../../typebox-BmZP6XXv.js";
import "../../web-search-plugin-factory-DStYVW2B.js";
import { n as applyKilocodeConfig } from "../../onboard-auth.config-core-RGiehkaJ.js";
import "../../onboard-auth.models-DgQQVW6a.js";
import "../../onboard-auth.config-minimax-CHFiQ6wX.js";
import "../../onboard-auth.config-opencode-BJ8anUQU.js";
import "../../onboard-auth-DCHJrlNU.js";
import { t as createProviderApiKeyAuthMethod } from "../../provider-api-key-auth-C_oZ2YEn.js";
import { i as isProxyReasoningUnsupported, t as createKilocodeWrapper } from "../../proxy-stream-wrappers-DWKjSlEe.js";
//#region extensions/kilocode/index.ts
const PROVIDER_ID = "kilocode";
const kilocodePlugin = {
	id: PROVIDER_ID,
	name: "Kilo Gateway Provider",
	description: "Bundled Kilo Gateway provider plugin",
	configSchema: emptyPluginConfigSchema(),
	register(api) {
		api.registerProvider({
			id: PROVIDER_ID,
			label: "Kilo Gateway",
			docsPath: "/providers/kilocode",
			envVars: ["KILOCODE_API_KEY"],
			auth: [createProviderApiKeyAuthMethod({
				providerId: PROVIDER_ID,
				methodId: "api-key",
				label: "Kilo Gateway API key",
				hint: "API key (OpenRouter-compatible)",
				optionKey: "kilocodeApiKey",
				flagName: "--kilocode-api-key",
				envVar: "KILOCODE_API_KEY",
				promptMessage: "Enter Kilo Gateway API key",
				defaultModel: KILOCODE_DEFAULT_MODEL_REF,
				expectedProviders: ["kilocode"],
				applyConfig: (cfg) => applyKilocodeConfig(cfg),
				wizard: {
					choiceId: "kilocode-api-key",
					choiceLabel: "Kilo Gateway API key",
					groupId: "kilocode",
					groupLabel: "Kilo Gateway",
					groupHint: "API key (OpenRouter-compatible)"
				}
			})],
			catalog: {
				order: "simple",
				run: async (ctx) => {
					const apiKey = ctx.resolveProviderApiKey(PROVIDER_ID).apiKey;
					if (!apiKey) return null;
					return { provider: {
						...await buildKilocodeProviderWithDiscovery(),
						apiKey
					} };
				}
			},
			capabilities: {
				geminiThoughtSignatureSanitization: true,
				geminiThoughtSignatureModelHints: ["gemini"]
			},
			wrapStreamFn: (ctx) => {
				const thinkingLevel = ctx.modelId === "kilo/auto" || isProxyReasoningUnsupported(ctx.modelId) ? void 0 : ctx.thinkingLevel;
				return createKilocodeWrapper(ctx.streamFn, thinkingLevel);
			},
			isCacheTtlEligible: (ctx) => ctx.modelId.startsWith("anthropic/")
		});
	}
};
//#endregion
export { kilocodePlugin as default };
