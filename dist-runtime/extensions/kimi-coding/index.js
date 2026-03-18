import "../../provider-env-vars-BfZUtZAn.js";
import { t as emptyPluginConfigSchema } from "../../config-schema-DpOJkOlS.js";
import "../../resolve-route-CQsiaDZO.js";
import "../../logger-BOdgfoqz.js";
import "../../tmp-openclaw-dir-DgEKZnX6.js";
import "../../paths-CbmqEZIn.js";
import "../../subsystem-CsPxmH8p.js";
import { l as init_utils, u as isRecord } from "../../utils-CMc9mmF8.js";
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
import { l as buildKimiCodingProvider } from "../../models-config.providers.static-DRBnLpDj.js";
import "../../models-config.providers.discovery-gVOHvGnm.js";
import "../../pairing-token-Do-E3rL5.js";
import "../../query-expansion-Do6vyPvH.js";
import "../../redact-BZcL_gJG.js";
import "../../mime-33LCeGh-.js";
import "../../typebox-B4kR5eyM.js";
import "../../web-search-plugin-factory-CeUlA68v.js";
import { r as applyKimiCodeConfig } from "../../onboard-auth.config-core-C8O7u8CI.js";
import { n as KIMI_CODING_MODEL_REF } from "../../onboard-auth.models-DU-07n1Q.js";
import "../../onboard-auth.config-minimax-BZLhwFh4.js";
import "../../onboard-auth.config-opencode-CPtsorYE.js";
import "../../onboard-auth-D_nBXMz2.js";
import { t as createProviderApiKeyAuthMethod } from "../../provider-api-key-auth-8PSAQte9.js";
//#region extensions/kimi-coding/index.ts
init_utils();
const PROVIDER_ID = "kimi-coding";
const kimiCodingPlugin = {
	id: PROVIDER_ID,
	name: "Kimi Coding Provider",
	description: "Bundled Kimi Coding provider plugin",
	configSchema: emptyPluginConfigSchema(),
	register(api) {
		api.registerProvider({
			id: PROVIDER_ID,
			label: "Kimi Coding",
			aliases: ["kimi-code"],
			docsPath: "/providers/moonshot",
			envVars: ["KIMI_API_KEY", "KIMICODE_API_KEY"],
			auth: [createProviderApiKeyAuthMethod({
				providerId: PROVIDER_ID,
				methodId: "api-key",
				label: "Kimi Code API key (subscription)",
				hint: "Kimi K2.5 + Kimi Coding",
				optionKey: "kimiCodeApiKey",
				flagName: "--kimi-code-api-key",
				envVar: "KIMI_API_KEY",
				promptMessage: "Enter Kimi Coding API key",
				defaultModel: KIMI_CODING_MODEL_REF,
				expectedProviders: ["kimi-code", "kimi-coding"],
				applyConfig: (cfg) => applyKimiCodeConfig(cfg),
				noteMessage: ["Kimi Coding uses a dedicated endpoint and API key.", "Get your API key at: https://www.kimi.com/code/en"].join("\n"),
				noteTitle: "Kimi Coding",
				wizard: {
					choiceId: "kimi-code-api-key",
					choiceLabel: "Kimi Code API key (subscription)",
					groupId: "moonshot",
					groupLabel: "Moonshot AI (Kimi K2.5)",
					groupHint: "Kimi K2.5 + Kimi Coding"
				}
			})],
			catalog: {
				order: "simple",
				run: async (ctx) => {
					const apiKey = ctx.resolveProviderApiKey(PROVIDER_ID).apiKey;
					if (!apiKey) return null;
					const explicitProvider = ctx.config.models?.providers?.[PROVIDER_ID];
					const builtInProvider = buildKimiCodingProvider();
					const explicitBaseUrl = typeof explicitProvider?.baseUrl === "string" ? explicitProvider.baseUrl.trim() : "";
					const explicitHeaders = isRecord(explicitProvider?.headers) ? explicitProvider.headers : void 0;
					return { provider: {
						...builtInProvider,
						...explicitBaseUrl ? { baseUrl: explicitBaseUrl } : {},
						...explicitHeaders ? { headers: {
							...builtInProvider.headers,
							...explicitHeaders
						} } : {},
						apiKey
					} };
				}
			},
			capabilities: { preserveAnthropicThinkingSignatures: false }
		});
	}
};
//#endregion
export { kimiCodingPlugin as default };
