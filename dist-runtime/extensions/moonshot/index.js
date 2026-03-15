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
import "../../paths-OqPpu-UR.js";
import { Mn as createMoonshotThinkingWrapper, Nn as resolveMoonshotThinkingType } from "../../auth-profiles-CuJtivJK.js";
import "../../profiles-CV7WLKIX.js";
import "../../fetch-D2ZOzaXt.js";
import "../../external-content-vZzOHxnd.js";
import "../../kilocode-shared-Ci8SRxXc.js";
import { p as buildMoonshotProvider } from "../../models-config.providers.static-DRBnLpDj.js";
import "../../models-config.providers.discovery-l-LpSxGW.js";
import "../../pairing-token-DKpN4qO0.js";
import "../../query-expansion-txqQdNIf.js";
import "../../redact-BefI-5cC.js";
import "../../mime-33LCeGh-.js";
import "../../typebox-BmZP6XXv.js";
import { i as setScopedCredentialValue, n as getScopedCredentialValue, t as createPluginBackedWebSearchProvider } from "../../web-search-plugin-factory-DStYVW2B.js";
import { c as applyMoonshotConfigCn, s as applyMoonshotConfig } from "../../onboard-auth.config-core-RGiehkaJ.js";
import { m as MOONSHOT_DEFAULT_MODEL_REF } from "../../onboard-auth.models-DgQQVW6a.js";
import { t as createProviderApiKeyAuthMethod } from "../../provider-api-key-auth-C_oZ2YEn.js";
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
