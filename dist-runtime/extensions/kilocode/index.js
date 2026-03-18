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
import { a as KILOCODE_DEFAULT_MODEL_REF } from "../../kilocode-shared-Ci8SRxXc.js";
import "../../models-config.providers.static-DRBnLpDj.js";
import { n as buildKilocodeProviderWithDiscovery } from "../../models-config.providers.discovery-gVOHvGnm.js";
import "../../pairing-token-Do-E3rL5.js";
import "../../query-expansion-Do6vyPvH.js";
import "../../redact-BZcL_gJG.js";
import "../../mime-33LCeGh-.js";
import "../../typebox-B4kR5eyM.js";
import "../../web-search-plugin-factory-CeUlA68v.js";
import { n as applyKilocodeConfig } from "../../onboard-auth.config-core-C8O7u8CI.js";
import "../../onboard-auth.models-DU-07n1Q.js";
import "../../onboard-auth.config-minimax-BZLhwFh4.js";
import "../../onboard-auth.config-opencode-CPtsorYE.js";
import "../../onboard-auth-D_nBXMz2.js";
import { t as createProviderApiKeyAuthMethod } from "../../provider-api-key-auth-8PSAQte9.js";
import { i as isProxyReasoningUnsupported, t as createKilocodeWrapper } from "../../proxy-stream-wrappers-DWMSrraJ.js";
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
