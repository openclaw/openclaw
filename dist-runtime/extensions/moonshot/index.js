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
import "../../paths-DAoqckDF.js";
import { In as createMoonshotThinkingWrapper, Ln as resolveMoonshotThinkingType } from "../../auth-profiles-B70DPAVa.js";
import "../../profiles-BC4VpDll.js";
import "../../fetch-BX2RRCzB.js";
import "../../external-content-CxoN_TKD.js";
import "../../kilocode-shared-Ci8SRxXc.js";
import { p as buildMoonshotProvider } from "../../models-config.providers.static-DRBnLpDj.js";
import "../../models-config.providers.discovery-gVOHvGnm.js";
import "../../pairing-token-Do-E3rL5.js";
import "../../query-expansion-Do6vyPvH.js";
import "../../redact-BZcL_gJG.js";
import "../../mime-33LCeGh-.js";
import "../../typebox-B4kR5eyM.js";
import { i as setScopedCredentialValue, n as getScopedCredentialValue, t as createPluginBackedWebSearchProvider } from "../../web-search-plugin-factory-CeUlA68v.js";
import { c as applyMoonshotConfigCn, s as applyMoonshotConfig } from "../../onboard-auth.config-core-C8O7u8CI.js";
import { m as MOONSHOT_DEFAULT_MODEL_REF } from "../../onboard-auth.models-DU-07n1Q.js";
import { t as createProviderApiKeyAuthMethod } from "../../provider-api-key-auth-8PSAQte9.js";
//#region extensions/moonshot/index.ts
const PROVIDER_ID = "moonshot";
const moonshotPlugin = {
	id: PROVIDER_ID,
	name: "Moonshot Provider",
	description: "Bundled Moonshot provider plugin",
	configSchema: emptyPluginConfigSchema(),
	register(api) {
		api.registerProvider({
			id: PROVIDER_ID,
			label: "Moonshot",
			docsPath: "/providers/moonshot",
			envVars: ["MOONSHOT_API_KEY"],
			auth: [createProviderApiKeyAuthMethod({
				providerId: PROVIDER_ID,
				methodId: "api-key",
				label: "Kimi API key (.ai)",
				hint: "Kimi K2.5 + Kimi Coding",
				optionKey: "moonshotApiKey",
				flagName: "--moonshot-api-key",
				envVar: "MOONSHOT_API_KEY",
				promptMessage: "Enter Moonshot API key",
				defaultModel: MOONSHOT_DEFAULT_MODEL_REF,
				expectedProviders: ["moonshot"],
				applyConfig: (cfg) => applyMoonshotConfig(cfg),
				wizard: {
					choiceId: "moonshot-api-key",
					choiceLabel: "Kimi API key (.ai)",
					groupId: "moonshot",
					groupLabel: "Moonshot AI (Kimi K2.5)",
					groupHint: "Kimi K2.5 + Kimi Coding"
				}
			}), createProviderApiKeyAuthMethod({
				providerId: PROVIDER_ID,
				methodId: "api-key-cn",
				label: "Kimi API key (.cn)",
				hint: "Kimi K2.5 + Kimi Coding",
				optionKey: "moonshotApiKey",
				flagName: "--moonshot-api-key",
				envVar: "MOONSHOT_API_KEY",
				promptMessage: "Enter Moonshot API key (.cn)",
				defaultModel: MOONSHOT_DEFAULT_MODEL_REF,
				expectedProviders: ["moonshot"],
				applyConfig: (cfg) => applyMoonshotConfigCn(cfg),
				wizard: {
					choiceId: "moonshot-api-key-cn",
					choiceLabel: "Kimi API key (.cn)",
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
					const explicitBaseUrl = typeof explicitProvider?.baseUrl === "string" ? explicitProvider.baseUrl.trim() : "";
					return { provider: {
						...buildMoonshotProvider(),
						...explicitBaseUrl ? { baseUrl: explicitBaseUrl } : {},
						apiKey
					} };
				}
			},
			wrapStreamFn: (ctx) => {
				const thinkingType = resolveMoonshotThinkingType({
					configuredThinking: ctx.extraParams?.thinking,
					thinkingLevel: ctx.thinkingLevel
				});
				return createMoonshotThinkingWrapper(ctx.streamFn, thinkingType);
			}
		});
		api.registerWebSearchProvider(createPluginBackedWebSearchProvider({
			id: "kimi",
			label: "Kimi (Moonshot)",
			hint: "Moonshot web search",
			envVars: ["KIMI_API_KEY", "MOONSHOT_API_KEY"],
			placeholder: "sk-...",
			signupUrl: "https://platform.moonshot.cn/",
			docsUrl: "https://docs.openclaw.ai/tools/web",
			autoDetectOrder: 40,
			getCredentialValue: (searchConfig) => getScopedCredentialValue(searchConfig, "kimi"),
			setCredentialValue: (searchConfigTarget, value) => setScopedCredentialValue(searchConfigTarget, "kimi", value)
		}));
	}
};
//#endregion
export { moonshotPlugin as default };
