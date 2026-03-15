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
import "../../profiles-CV7WLKIX.js";
import { n as OPENCODE_GO_DEFAULT_MODEL_REF, t as applyOpencodeGoConfig } from "../../onboard-auth.config-opencode-go-DvnhaIPX.js";
import { t as createProviderApiKeyAuthMethod } from "../../provider-api-key-auth-C_oZ2YEn.js";
//#region extensions/opencode-go/index.ts
const PROVIDER_ID = "opencode-go";
const opencodeGoPlugin = {
	id: PROVIDER_ID,
	name: "OpenCode Go Provider",
	description: "Bundled OpenCode Go provider plugin",
	configSchema: emptyPluginConfigSchema(),
	register(api) {
		api.registerProvider({
			id: PROVIDER_ID,
			label: "OpenCode Go",
			docsPath: "/providers/models",
			envVars: ["OPENCODE_API_KEY", "OPENCODE_ZEN_API_KEY"],
			auth: [createProviderApiKeyAuthMethod({
				providerId: PROVIDER_ID,
				methodId: "api-key",
				label: "OpenCode Go catalog",
				hint: "Shared API key for Zen + Go catalogs",
				optionKey: "opencodeGoApiKey",
				flagName: "--opencode-go-api-key",
				envVar: "OPENCODE_API_KEY",
				promptMessage: "Enter OpenCode API key",
				profileIds: ["opencode:default", "opencode-go:default"],
				defaultModel: OPENCODE_GO_DEFAULT_MODEL_REF,
				expectedProviders: ["opencode", "opencode-go"],
				applyConfig: (cfg) => applyOpencodeGoConfig(cfg),
				noteMessage: [
					"OpenCode uses one API key across the Zen and Go catalogs.",
					"Go focuses on Kimi, GLM, and MiniMax coding models.",
					"Get your API key at: https://opencode.ai/auth"
				].join("\n"),
				noteTitle: "OpenCode",
				wizard: {
					choiceId: "opencode-go",
					choiceLabel: "OpenCode Go catalog",
					groupId: "opencode",
					groupLabel: "OpenCode",
					groupHint: "Shared API key for Zen + Go catalogs"
				}
			})],
			capabilities: {
				openAiCompatTurnValidation: false,
				geminiThoughtSignatureSanitization: true,
				geminiThoughtSignatureModelHints: ["gemini"]
			},
			isModernModelRef: () => true
		});
	}
};
//#endregion
export { opencodeGoPlugin as default };
