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
import "../../auth-profiles-CuJtivJK.js";
import { l as normalizeProviderId } from "../../profiles-CV7WLKIX.js";
import "../../fetch-D2ZOzaXt.js";
import "../../external-content-vZzOHxnd.js";
import "../../kilocode-shared-Ci8SRxXc.js";
import "../../models-config.providers.static-DRBnLpDj.js";
import "../../models-config.providers.discovery-l-LpSxGW.js";
import "../../pairing-token-DKpN4qO0.js";
import "../../query-expansion-txqQdNIf.js";
import "../../redact-BefI-5cC.js";
import "../../mime-33LCeGh-.js";
import "../../typebox-BmZP6XXv.js";
import { i as setScopedCredentialValue, n as getScopedCredentialValue, t as createPluginBackedWebSearchProvider } from "../../web-search-plugin-factory-DStYVW2B.js";
import { m as applyXaiConfig } from "../../onboard-auth.config-core-RGiehkaJ.js";
import { v as XAI_DEFAULT_MODEL_REF } from "../../onboard-auth.models-DgQQVW6a.js";
import "../../onboard-auth.config-minimax-CHFiQ6wX.js";
import "../../onboard-auth.config-opencode-BJ8anUQU.js";
import "../../onboard-auth-DCHJrlNU.js";
import { t as createProviderApiKeyAuthMethod } from "../../provider-api-key-auth-C_oZ2YEn.js";
//#region extensions/xai/index.ts
const PROVIDER_ID = "xai";
const XAI_MODERN_MODEL_PREFIXES = ["grok-4"];
function matchesModernXaiModel(modelId) {
	const normalized = modelId.trim().toLowerCase();
	return XAI_MODERN_MODEL_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}
const xaiPlugin = {
	id: "xai",
	name: "xAI Plugin",
	description: "Bundled xAI plugin",
	configSchema: emptyPluginConfigSchema(),
	register(api) {
		api.registerProvider({
			id: PROVIDER_ID,
			label: "xAI",
			docsPath: "/providers/models",
			envVars: ["XAI_API_KEY"],
			auth: [createProviderApiKeyAuthMethod({
				providerId: PROVIDER_ID,
				methodId: "api-key",
				label: "xAI API key",
				hint: "API key",
				optionKey: "xaiApiKey",
				flagName: "--xai-api-key",
				envVar: "XAI_API_KEY",
				promptMessage: "Enter xAI API key",
				defaultModel: XAI_DEFAULT_MODEL_REF,
				expectedProviders: ["xai"],
				applyConfig: (cfg) => applyXaiConfig(cfg),
				wizard: {
					choiceId: "xai-api-key",
					choiceLabel: "xAI API key",
					groupId: "xai",
					groupLabel: "xAI (Grok)",
					groupHint: "API key"
				}
			})],
			isModernModelRef: ({ provider, modelId }) => normalizeProviderId(provider) === "xai" ? matchesModernXaiModel(modelId) : void 0
		});
		api.registerWebSearchProvider(createPluginBackedWebSearchProvider({
			id: "grok",
			label: "Grok (xAI)",
			hint: "xAI web-grounded responses",
			envVars: ["XAI_API_KEY"],
			placeholder: "xai-...",
			signupUrl: "https://console.x.ai/",
			docsUrl: "https://docs.openclaw.ai/tools/web",
			autoDetectOrder: 30,
			getCredentialValue: (searchConfig) => getScopedCredentialValue(searchConfig, "grok"),
			setCredentialValue: (searchConfigTarget, value) => setScopedCredentialValue(searchConfigTarget, "grok", value)
		}));
	}
};
//#endregion
export { xaiPlugin as default };
