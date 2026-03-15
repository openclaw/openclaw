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
import { f as buildModelStudioProvider } from "../../models-config.providers.static-DRBnLpDj.js";
import "../../models-config.providers.discovery-l-LpSxGW.js";
import "../../pairing-token-DKpN4qO0.js";
import "../../query-expansion-txqQdNIf.js";
import "../../redact-BefI-5cC.js";
import "../../mime-33LCeGh-.js";
import "../../typebox-BmZP6XXv.js";
import "../../web-search-plugin-factory-DStYVW2B.js";
import { a as applyModelStudioConfig, o as applyModelStudioConfigCn } from "../../onboard-auth.config-core-RGiehkaJ.js";
import { l as MODELSTUDIO_DEFAULT_MODEL_REF } from "../../onboard-auth.models-DgQQVW6a.js";
import "../../onboard-auth.config-minimax-CHFiQ6wX.js";
import "../../onboard-auth.config-opencode-BJ8anUQU.js";
import "../../onboard-auth-DCHJrlNU.js";
import { t as createProviderApiKeyAuthMethod } from "../../provider-api-key-auth-C_oZ2YEn.js";
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
