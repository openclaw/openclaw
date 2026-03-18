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
import "../../auth-profiles-B70DPAVa.js";
import { l as normalizeProviderId } from "../../profiles-BC4VpDll.js";
import "../../fetch-BX2RRCzB.js";
import "../../external-content-CxoN_TKD.js";
import "../../kilocode-shared-Ci8SRxXc.js";
import "../../models-config.providers.static-DRBnLpDj.js";
import "../../models-config.providers.discovery-gVOHvGnm.js";
import "../../pairing-token-Do-E3rL5.js";
import "../../query-expansion-Do6vyPvH.js";
import "../../redact-BZcL_gJG.js";
import "../../mime-33LCeGh-.js";
import "../../typebox-B4kR5eyM.js";
import { i as setScopedCredentialValue, n as getScopedCredentialValue, t as createPluginBackedWebSearchProvider } from "../../web-search-plugin-factory-CeUlA68v.js";
import { m as applyXaiConfig } from "../../onboard-auth.config-core-C8O7u8CI.js";
import { v as XAI_DEFAULT_MODEL_REF } from "../../onboard-auth.models-DU-07n1Q.js";
import "../../onboard-auth.config-minimax-BZLhwFh4.js";
import "../../onboard-auth.config-opencode-CPtsorYE.js";
import "../../onboard-auth-D_nBXMz2.js";
import { t as createProviderApiKeyAuthMethod } from "../../provider-api-key-auth-8PSAQte9.js";
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
