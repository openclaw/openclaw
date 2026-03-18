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
import { f as buildModelStudioProvider } from "../../models-config.providers.static-DRBnLpDj.js";
import "../../models-config.providers.discovery-gVOHvGnm.js";
import "../../pairing-token-Do-E3rL5.js";
import "../../query-expansion-Do6vyPvH.js";
import "../../redact-BZcL_gJG.js";
import "../../mime-33LCeGh-.js";
import "../../typebox-B4kR5eyM.js";
import "../../web-search-plugin-factory-CeUlA68v.js";
import { a as applyModelStudioConfig, o as applyModelStudioConfigCn } from "../../onboard-auth.config-core-C8O7u8CI.js";
import { l as MODELSTUDIO_DEFAULT_MODEL_REF } from "../../onboard-auth.models-DU-07n1Q.js";
import "../../onboard-auth.config-minimax-BZLhwFh4.js";
import "../../onboard-auth.config-opencode-CPtsorYE.js";
import "../../onboard-auth-D_nBXMz2.js";
import { t as createProviderApiKeyAuthMethod } from "../../provider-api-key-auth-8PSAQte9.js";
//#region extensions/modelstudio/index.ts
const PROVIDER_ID = "modelstudio";
const modelStudioPlugin = {
	id: PROVIDER_ID,
	name: "Model Studio Provider",
	description: "Bundled Model Studio provider plugin",
	configSchema: emptyPluginConfigSchema(),
	register(api) {
		api.registerProvider({
			id: PROVIDER_ID,
			label: "Model Studio",
			docsPath: "/providers/models",
			envVars: ["MODELSTUDIO_API_KEY"],
			auth: [createProviderApiKeyAuthMethod({
				providerId: PROVIDER_ID,
				methodId: "api-key-cn",
				label: "Coding Plan API Key for China (subscription)",
				hint: "Endpoint: coding.dashscope.aliyuncs.com",
				optionKey: "modelstudioApiKeyCn",
				flagName: "--modelstudio-api-key-cn",
				envVar: "MODELSTUDIO_API_KEY",
				promptMessage: "Enter Alibaba Cloud Model Studio Coding Plan API key (China)",
				defaultModel: MODELSTUDIO_DEFAULT_MODEL_REF,
				expectedProviders: ["modelstudio"],
				applyConfig: (cfg) => applyModelStudioConfigCn(cfg),
				noteMessage: [
					"Get your API key at: https://bailian.console.aliyun.com/",
					"Endpoint: coding.dashscope.aliyuncs.com",
					"Models: qwen3.5-plus, glm-4.7, kimi-k2.5, MiniMax-M2.5, etc."
				].join("\n"),
				noteTitle: "Alibaba Cloud Model Studio Coding Plan (China)",
				wizard: {
					choiceId: "modelstudio-api-key-cn",
					choiceLabel: "Coding Plan API Key for China (subscription)",
					choiceHint: "Endpoint: coding.dashscope.aliyuncs.com",
					groupId: "modelstudio",
					groupLabel: "Alibaba Cloud Model Studio",
					groupHint: "Coding Plan API key (CN / Global)"
				}
			}), createProviderApiKeyAuthMethod({
				providerId: PROVIDER_ID,
				methodId: "api-key",
				label: "Coding Plan API Key for Global/Intl (subscription)",
				hint: "Endpoint: coding-intl.dashscope.aliyuncs.com",
				optionKey: "modelstudioApiKey",
				flagName: "--modelstudio-api-key",
				envVar: "MODELSTUDIO_API_KEY",
				promptMessage: "Enter Alibaba Cloud Model Studio Coding Plan API key (Global/Intl)",
				defaultModel: MODELSTUDIO_DEFAULT_MODEL_REF,
				expectedProviders: ["modelstudio"],
				applyConfig: (cfg) => applyModelStudioConfig(cfg),
				noteMessage: [
					"Get your API key at: https://bailian.console.aliyun.com/",
					"Endpoint: coding-intl.dashscope.aliyuncs.com",
					"Models: qwen3.5-plus, glm-4.7, kimi-k2.5, MiniMax-M2.5, etc."
				].join("\n"),
				noteTitle: "Alibaba Cloud Model Studio Coding Plan (Global/Intl)",
				wizard: {
					choiceId: "modelstudio-api-key",
					choiceLabel: "Coding Plan API Key for Global/Intl (subscription)",
					choiceHint: "Endpoint: coding-intl.dashscope.aliyuncs.com",
					groupId: "modelstudio",
					groupLabel: "Alibaba Cloud Model Studio",
					groupHint: "Coding Plan API key (CN / Global)"
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
						...buildModelStudioProvider(),
						...explicitBaseUrl ? { baseUrl: explicitBaseUrl } : {},
						apiKey
					} };
				}
			}
		});
	}
};
//#endregion
export { modelStudioPlugin as default };
